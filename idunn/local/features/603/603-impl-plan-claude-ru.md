# План имплементации тикета 603: Серверная интеграция AMS через RabbitMQ

## Цель и контекст

**Что делаем:** Добавляем поддержку загрузки ресурсов из AMS (Asset Management System) при серверном выполнении графов, параллельно с существующими ресурсами "generator".

**Зачем:** 
- Разблокировать использование централизованных активов из AMS в серверных прогонах и заказах
- Подготовить фундамент для ProRes поддержки в видео (следующий тикет)
- Сохранить существующую функциональность браузера

**Как:** Протягиваем новый параметр `source: 'generator' | 'ams'` через всю цепочку: компилятор → описание операции → узлы → имплементации → хранилище. Добавляем RabbitMQ клиент для AMS.

## Архитектурное видение

### Текущее состояние
- Ресурсы в SourceGraph: `{ resourceRef: string }`
- Операция `Load Resource`: 2 аргумента `[resourceType, ref]`  
- ResourceStorage работает только с generator-ресурсами через blob

### Целевое состояние
- Ресурсы в SourceGraph: `{ resourceRef: string } | { ams: string }` (уже есть)
- Операция `Load Resource`: 3 аргумента `[resourceType, ref, source]`
- ResourceStorage: маршрутизация по `source` (generator → blob, ams → RabbitMQ)
- FFmpeg без принудительного MP4 формата

### Принципы архитектуры
- **Schema-first**: API/узлы через YAML + кодогенерация, платформенные типы ручные
- **Graceful degradation**: AMS недоступен → ошибка с контекстом, опционально fallback
- **Обратная совместимость**: старые графы с `{ resourceRef }` продолжают работать
- **Type safety**: используем generated types и validation

## Детальный план по файлам

### 1. Описание операции и генерация узла

#### `src/platform/generic/data/operations/loadResource.ts`
```typescript
// ИЗМЕНИТЬ: количество аргументов с 2 до 3
export const loadResourceOperation: OperationDescription = {
  args: [
    'resource type',      // string
    'reference',          // string  
    'source'             // 'generator' | 'ams'
  ],
  // outputs остаются без изменений
}
```

#### `src/platform/generic/data/nodeClasses/processing/LoadResources/getLoadResourceNodeClass.ts`
```typescript
// ДОБАВИТЬ: параметр source в генерируемый узел
// В operationCall.args добавить третий аргумент:
{ source: 'parameter', name: 'source' }

// Узел получает параметры: ref (string), source (string)
```

#### `src/core/compiler/nodes/normalizeSourceGraphForCompiler/loadResourceParameterViaNode.ts`
```typescript
// ИЗМЕНИТЬ: логику создания узла загрузки
// Если parameter.value = { resourceRef } → ref = resourceRef, source = 'generator'
// Если parameter.value = { ams } → ref = ams, source = 'ams'

const loadResourceNode = {
  ref: isAmsResource(parameter.value) ? parameter.value.ams : parameter.value.resourceRef,
  source: isAmsResource(parameter.value) ? 'ams' : 'generator'
}
```

### 2. Платформенные типы и валидаторы

#### `src/platform/types/Services/ResourceStorage.ts`
```typescript
// ИЗМЕНИТЬ: ResourceReference на юнион
type ResourceReference = 
  | { resourceRef: string } 
  | { ams: string }

// GetResource и ResourceStorage остаются с ResourceReference
```

#### `src/types/InteroperationTypes/ValuePredicates.ts`
```typescript
// ОБНОВИТЬ: isValidResourceReference
export function isValidResourceReference(value: unknown): value is ResourceReference {
  return isValidGeneratorResourceReference(value) || isValidAMSResourceReference(value)
}

// ДОБАВИТЬ: специфические гарды
export function isValidGeneratorResourceReference(value: unknown): value is { resourceRef: string } {
  return typeof value === 'object' && value !== null && 
         typeof (value as any).resourceRef === 'string'
}

export function isValidAMSResourceReference(value: unknown): value is { ams: string } {
  return typeof value === 'object' && value !== null && 
         typeof (value as any).ams === 'string'
}
```

### 3. Имплементации операций

#### `src/graphics/server/operations/loadResource.ts`
```typescript
// ИЗМЕНИТЬ: принимать 3 аргумента
export async function loadResource(
  services: OperationServices,
  resourceType: string,
  ref: string,
  source: 'generator' | 'ams'
): Promise<OperationResult<Buffer | null>> {
  // Валидация source
  if (source !== 'generator' && source !== 'ams') {
    return { isOk: false, error: `Invalid source: ${source}` }
  }
  
  // Сборка ResourceReference по source
  const resourceReference: ResourceReference = 
    source === 'generator' ? { resourceRef: ref } : { ams: ref }
  
  // Вызов storage с включением source в ошибки
  try {
    const buffer = await services.resourceStorage.get(
      resourceReference, 
      { type: resourceType }, 
      config.scalingFactor
    )
    return { isOk: true, value: buffer }
  } catch (error) {
    return { isOk: false, error: `Failed to load ${source} resource ${ref}: ${error.message}` }
  }
}
```

#### `src/graphics/browser/operations/loadResource.ts`
```typescript
// ИЗМЕНИТЬ: принимать 3 аргумента (пока игнорировать source)
export async function loadResource(
  services: BrowserOperationServices,
  resourceType: string,
  ref: string,
  source: 'generator' | 'ams' // пока не используем
): Promise<OperationResult<Buffer | null>> {
  // Существующая логика без изменений
  // ViewerResourceStorage уже умеет работать с AMS URLs
}
```

### 4. Серверное ResourceStorage

#### `src/server/services/resources/storage.ts`
```typescript
// ДОБАВИТЬ: импорты новых гардов
import { 
  isValidGeneratorResourceReference, 
  isValidAMSResourceReference 
} from '../../../types/InteroperationTypes/ValuePredicates'

// ИЗМЕНИТЬ: get метод - добавить маршрутизацию
export class ResourceStorage implements IResourceStorage {
  async get(
    resourceReference: ResourceReference,
    type: { type: string },
    scalingFactor?: number
  ): Promise<Buffer | null> {
    
    // Проверка поддерживаемых типов (как раньше)
    if (!['image', 'binary', 'imageSequence'].includes(type.type)) {
      throw new Error(`Unsupported resource type: ${type.type}`)
    }
    
    // Маршрутизация по источнику
    if (isValidGeneratorResourceReference(resourceReference)) {
      // Существующая логика для generator без изменений
      return this.getGeneratorResource(resourceReference, type, scalingFactor)
    }
    
    if (isValidAMSResourceReference(resourceReference)) {
      // Новая ветка для AMS
      return this.getAMSResource(resourceReference, type, scalingFactor)
    }
    
    throw new Error(`Invalid resource reference: ${JSON.stringify(resourceReference)}`)
  }
  
  // ДОБАВИТЬ: методы для AMS
  private async getAMSResource(
    resourceRef: { ams: string },
    type: { type: string },
    scalingFactor?: number
  ): Promise<Buffer | null> {
    
    if (type.type === 'imageSequence') {
      throw new Error('AMS image sequences not supported yet')
    }
    
    if (!this.config.ams.enabled) {
      if (this.config.ams.fallbackEnabled) {
        // Пытаемся получить previewImage если есть
        return this.tryAMSFallback(resourceRef.ams)
      }
      return null
    }
    
    try {
      return await this.getAMSResourceViaRabbitMQ(
        resourceRef.ams, 
        type.type, 
        scalingFactor
      )
    } catch (error) {
      throw new Error(`AMS resource ${resourceRef.ams} failed: ${error.message}`)
    }
  }
  
  // ДОБАВИТЬ: RabbitMQ клиент вызов
  private async getAMSResourceViaRabbitMQ(
    assetId: string,
    resourceType: string,
    scalingFactor?: number
  ): Promise<Buffer | null> {
    
    // Получаем метаданные актива через RabbitMQ
    const assetMetadata = await this.amsClient.requestAssetMetadata({
      assetId,
      requestId: generateRequestId()
    })
    
    if (!assetMetadata.success) {
      throw new Error(assetMetadata.error || 'Failed to get asset metadata')
    }
    
    // Выбираем вариацию по типу ресурса
    let selectedVariation: { url: string; mimeType: string }
    
    if (resourceType === 'image') {
      selectedVariation = this.selectImageVariation(assetMetadata, scalingFactor)
    } else if (resourceType === 'binary') {
      // Для видео используем правила выбора
      selectedVariation = this.selectVideoVariation(assetMetadata, scalingFactor)
    } else {
      throw new Error(`Unsupported AMS resource type: ${resourceType}`)
    }
    
    // Скачиваем файл по URL
    const response = await fetch(selectedVariation.url)
    if (!response.ok) {
      throw new Error(`Failed to download ${selectedVariation.url}: ${response.status}`)
    }
    
    const buffer = Buffer.from(await response.arrayBuffer())
    
    // Нормализация для изображений
    if (resourceType === 'image') {
      return this.ensureImageProperties(buffer)
    }
    
    return buffer
  }
  
  // ДОБАВИТЬ: селекторы вариаций для видео (подготовка к ProRes тикету)
  private selectVideoVariation(
    assetMetadata: any,
    scalingFactor?: number
  ): { url: string; mimeType: string } {
    
    const videoData = this.services.videoData
    
    // Логика выбора для заказов (ProRes приоритет)
    if (this.isOrderContext() && this.config.ams.preferProResForOrders) {
      const proresVariation = this.findProResVariation(assetMetadata)
      if (proresVariation) {
        return proresVariation
      }
      
      // Fallback на максимальный MP4 если ProRes нет
      if (this.config.ams.mp4FallbackForOrders) {
        return this.findMaxResolutionMp4(assetMetadata)
      }
    }
    
    // Для серверного превью - ближайший по разрешению MP4
    return this.findClosestResolutionMp4(assetMetadata, scalingFactor || videoData?.height)
  }
  
  private selectImageVariation(
    assetMetadata: any,
    scalingFactor?: number
  ): { url: string; mimeType: string } {
    // Простой выбор по scale factor или берем оригинал
    const variations = assetMetadata.variations || []
    
    if (scalingFactor && scalingFactor < 1) {
      // Ищем подходящую по размеру вариацию
      const targetHeight = Math.floor(assetMetadata.originalHeight * scalingFactor)
      const closest = variations
        .filter((v: any) => v.type === 'image')
        .reduce((best: any, current: any) => {
          const bestDiff = Math.abs(best.height - targetHeight)
          const currentDiff = Math.abs(current.height - targetHeight)
          return currentDiff < bestDiff ? current : best
        })
      
      if (closest) return { url: closest.url, mimeType: closest.mimeType }
    }
    
    // Fallback на оригинал или previewImage
    return {
      url: assetMetadata.originalUrl || assetMetadata.previewImage?.url,
      mimeType: assetMetadata.originalMimeType || 'image/jpeg'
    }
  }
}
```

### 5. FFmpeg изменения

#### `src/graphics/server/operations/selectFrameFromVideo.ts`
```typescript
// УДАЛИТЬ: принудительное .inputFormat('mp4')
// В runFfmpeg убрать:
// .inputFormat('mp4')

// ДОБАВИТЬ: опциональное использование videoData.container
const ffmpeg = fluent(inputBuffer)
if (services.videoData?.container) {
  ffmpeg.inputFormat(services.videoData.container)
}
// Или полностью полагаться на автоопределение ffmpeg
```

### 6. RabbitMQ AMS клиент

#### `src/server/services/ams/rabbitMQClient.ts` (новый файл)
```typescript
import { Channel, Connection } from 'amqplib'
import { v4 as uuidv4 } from 'uuid'

export interface AMSResourceRequest {
  assetId: string
  parameters?: {
    scale?: number
    height?: number
    container?: string
  }
  resourceType: string
  requestId: string
}

export interface AMSResourceResponse {
  success: boolean
  requestId: string
  fileUrl?: string
  metadata?: any
  variations?: Array<{
    type: string
    url: string  
    mimeType: string
    height?: number
    container?: string
  }>
  error?: string
}

export class AMSRabbitMQClient {
  private channel: Channel | null = null
  private pendingRequests = new Map<string, {
    resolve: (response: AMSResourceResponse) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }>()
  
  constructor(
    private connection: Connection,
    private config: {
      requestQueue: string
      responseQueue: string  
      timeout: number
    }
  ) {}
  
  async initialize(): Promise<void> {
    this.channel = await this.connection.createChannel()
    
    // Объявляем очереди
    await this.channel.assertQueue(this.config.requestQueue, { durable: true })
    await this.channel.assertQueue(this.config.responseQueue, { durable: true })
    
    // Подписываемся на ответы
    await this.channel.consume(this.config.responseQueue, (msg) => {
      if (msg) {
        this.handleResponse(msg)
        this.channel!.ack(msg)
      }
    })
  }
  
  async requestAssetMetadata(request: AMSResourceRequest): Promise<AMSResourceResponse> {
    if (!this.channel) {
      throw new Error('AMS client not initialized')
    }
    
    const requestId = request.requestId || uuidv4()
    
    return new Promise((resolve, reject) => {
      // Таймаут
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`AMS request timeout for ${request.assetId}`))
      }, this.config.timeout)
      
      // Регистрируем ожидание ответа  
      this.pendingRequests.set(requestId, { resolve, reject, timeout })
      
      // Отправляем запрос
      this.channel!.sendToQueue(
        this.config.requestQueue,
        Buffer.from(JSON.stringify({ ...request, requestId })),
        {
          correlationId: requestId,
          replyTo: this.config.responseQueue
        }
      )
    })
  }
  
  private handleResponse(msg: any): void {
    try {
      const response: AMSResourceResponse = JSON.parse(msg.content.toString())
      const pending = this.pendingRequests.get(response.requestId)
      
      if (pending) {
        clearTimeout(pending.timeout)
        this.pendingRequests.delete(response.requestId)
        pending.resolve(response)
      }
    } catch (error) {
      console.error('Failed to handle AMS response:', error)
    }
  }
}
```

#### `src/server/mq/queues/ams.ts` (новый файл)
```typescript
export const AMS_QUEUES = {
  REQUEST: 'ams.request',
  RESPONSE: 'ams.response.server', 
  STATUS: 'ams.status'
} as const
```

#### `src/server/mq/listeners/ams.ts` (новый файл)
```typescript
import { AMSRabbitMQClient } from '../../services/ams/rabbitMQClient'
import { AMS_QUEUES } from '../queues/ams'

// Инициализация AMS клиента в общем MQ setup
export function setupAMSClient(connection: Connection, config: any): AMSRabbitMQClient {
  return new AMSRabbitMQClient(connection, {
    requestQueue: AMS_QUEUES.REQUEST,
    responseQueue: AMS_QUEUES.RESPONSE,
    timeout: config.ams.timeout
  })
}
```

### 7. Конфигурация

#### `src/server/configuration/environment.ts`
```typescript
// ДОБАВИТЬ: секцию ams
export interface Configuration {
  // существующие поля...
  ams: {
    enabled: boolean
    requestQueue: string
    responseQueue: string
    timeout: number
    fallbackEnabled: boolean
    preferProResForOrders: boolean
    mp4FallbackForOrders: boolean
  }
}

// В функции загрузки добавить:
ams: {
  enabled: process.env.AMS_ENABLED === 'true',
  requestQueue: process.env.AMS_REQUEST_QUEUE || 'ams.request',
  responseQueue: process.env.AMS_RESPONSE_QUEUE || 'ams.response.server', 
  timeout: parseInt(process.env.AMS_TIMEOUT_MS || '30000'),
  fallbackEnabled: process.env.AMS_FALLBACK_ENABLED === 'true',
  preferProResForOrders: process.env.AMS_PREFER_PRORES === 'true',
  mp4FallbackForOrders: process.env.AMS_MP4_FALLBACK === 'true'
}
```

#### `config/default.json`
```json
{
  "ams": {
    "enabled": "false",
    "requestQueue": "ams.request", 
    "responseQueue": "ams.response.server",
    "timeout": "30000",
    "fallbackEnabled": "true",
    "preferProResForOrders": "false", 
    "mp4FallbackForOrders": "true"
  }
}
```

#### `docker-compose.yml`
```yaml
# ДОБАВИТЬ: environment переменные для server
services:
  server:
    environment:
      - AMS_ENABLED=${AMS_ENABLED:-false}
      - AMS_REQUEST_QUEUE=${AMS_REQUEST_QUEUE:-ams.request}
      - AMS_RESPONSE_QUEUE=${AMS_RESPONSE_QUEUE:-ams.response.server}
      - AMS_TIMEOUT_MS=${AMS_TIMEOUT_MS:-30000}
      - AMS_FALLBACK_ENABLED=${AMS_FALLBACK_ENABLED:-true}
```

### 8. Тесты

#### `src/graphics/server/operations/__tests__/loadResource.test.ts`
```typescript
describe('loadResource with AMS support', () => {
  it('should handle generator resources (backward compatibility)', async () => {
    const result = await loadResource(mockServices, 'image', 'test-ref', 'generator')
    expect(result.isOk).toBe(true)
  })
  
  it('should handle AMS resources', async () => {
    // Мокируем MQ ответ
    mockServices.resourceStorage.get = jest.fn().mockResolvedValue(Buffer.from('ams-image'))
    
    const result = await loadResource(mockServices, 'image', 'ams-asset-123', 'ams')
    expect(result.isOk).toBe(true)
    expect(mockServices.resourceStorage.get).toHaveBeenCalledWith(
      { ams: 'ams-asset-123' },
      { type: 'image' },
      expect.any(Number)
    )
  })
  
  it('should validate source parameter', async () => {
    const result = await loadResource(mockServices, 'image', 'test', 'invalid' as any)
    expect(result.isOk).toBe(false)
    expect(result.error).toContain('Invalid source')
  })
})
```

#### `src/server/services/resources/__tests__/storage.ams.test.ts` (новый файл)
```typescript
describe('ResourceStorage AMS integration', () => {
  let storage: ResourceStorage
  let mockAMSClient: jest.Mocked<AMSRabbitMQClient>
  
  beforeEach(() => {
    mockAMSClient = {
      requestAssetMetadata: jest.fn()
    } as any
    
    storage = new ResourceStorage({
      ams: { enabled: true, fallbackEnabled: false }
    }, mockAMSClient)
  })
  
  it('should load AMS image via RabbitMQ', async () => {
    // Мок ответа от AMS
    mockAMSClient.requestAssetMetadata.mockResolvedValue({
      success: true,
      metadata: { originalUrl: 'https://cdn.example.com/image.png' },
      variations: []
    })
    
    // Мок fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024))
    })
    
    const result = await storage.get({ ams: 'test-asset' }, { type: 'image' })
    
    expect(result).toBeInstanceOf(Buffer)
    expect(mockAMSClient.requestAssetMetadata).toHaveBeenCalledWith({
      assetId: 'test-asset',
      requestId: expect.any(String)
    })
  })
  
  it('should select video variation correctly', async () => {
    const assetMetadata = {
      variations: [
        { type: 'video', container: 'mp4', height: 1080, url: 'test1080.mp4' },
        { type: 'video', container: 'mp4', height: 720, url: 'test720.mp4' },
        { type: 'video', container: 'mov', height: 1080, url: 'test1080.mov' }
      ]
    }
    
    // Тест выбора ProRes для заказов
    const proresResult = storage.selectVideoVariation(assetMetadata, { isOrder: true })
    expect(proresResult.url).toBe('test1080.mov')
    
    // Тест выбора ближайшего MP4 для превью
    const mp4Result = storage.selectVideoVariation(assetMetadata, { targetHeight: 720 })
    expect(mp4Result.url).toBe('test720.mp4')
  })
})
```

## Порядок выполнения (чеклист)

1. **Обновить описание операции и генерацию узла**
   - [ ] `src/platform/generic/data/operations/loadResource.ts` - 3 аргумента
   - [ ] `getLoadResourceNodeClass.ts` - добавить параметр source
   - [ ] `loadResourceParameterViaNode.ts` - логика выбора source

2. **Обновить платформенные типы и валидаторы**  
   - [ ] `ResourceStorage.ts` - юнион ResourceReference
   - [ ] `ValuePredicates.ts` - новые гарды

3. **Обновить имплементации операций**
   - [ ] `server/operations/loadResource.ts` - 3 аргумента + маршрутизация
   - [ ] `browser/operations/loadResource.ts` - 3 аргумента (игнорировать source)

4. **Обновить ResourceStorage на сервере**
   - [ ] `storage.ts` - маршрутизация generator vs AMS  
   - [ ] Добавить заглушки методов AMS

5. **Убрать принудительный MP4 в FFmpeg**
   - [ ] `selectFrameFromVideo.ts` - удалить `.inputFormat('mp4')`

6. **Реализовать RabbitMQ AMS клиент**
   - [ ] `services/ams/rabbitMQClient.ts` - новый клиент
   - [ ] `mq/queues/ams.ts` - константы очередей
   - [ ] `mq/listeners/ams.ts` - setup клиента
   - [ ] Подключить клиент к storage.ts

7. **Добавить конфигурацию**
   - [ ] `environment.ts` - секция ams
   - [ ] `config/default.json` - дефолты
   - [ ] `docker-compose.yml` - env переменные

8. **Тесты**
   - [ ] `loadResource.test.ts` - обновить на 3 аргумента
   - [ ] `storage.ams.test.ts` - новые тесты AMS ветки  
   - [ ] `selectFrameFromVideo.test.ts` - без MP4 предположения

9. **Финальная проверка**
   - [ ] `npm run build-json-schema-types` - обновить типы
   - [ ] `npm run typecheck` - проверка типов
   - [ ] `npm run test` - все тесты зелёные
   - [ ] `npm run lint` - код style

## Критические технические моменты

### Schema-first правила
- **YAML схемы**: только для API контractов в `documentation/api/schemas/`
- **Платформенные типы**: ручные в `src/platform/types/` и `src/types/`
- **AMS схема**: уже есть в `regularNode.yaml` как `amsResource`
- **Валидаторы**: ручные в `ValuePredicates.ts`, не генерируются

### Обработка ошибок
- AMS недоступен + `{ ams }` параметр → **ошибка** с контекстом
- `fallbackEnabled=true` → пробуем `previewImage` если есть  
- Таймауты RabbitMQ → осмысленные ошибки с assetId

### Video selection правила (подготовка к ProRes тикету)
- **Заказ** + `preferProResForOrders=true` → ProRes MOV, fallback максимальный MP4
- **Серверное превью** → ближайший MP4 по разрешению (scalingFactor)
- **Нет вариаций** → ошибка с доступными опциями

### Производительность
- **Таймауты**: MQ запросы 30s по умолчанию
- **Кэширование**: MVP полагается на AMS/CDN
- **Батчинг**: не в MVP, при необходимости позже

## Критерии готовности

- [ ] Операция `Load Resource` принимает 3 аргумента везде
- [ ] Графы с `{ resourceRef }` работают как раньше  
- [ ] Графы с `{ ams }` загружают ресурсы через RabbitMQ
- [ ] `Select Frame From Video` работает с MP4 и MOV
- [ ] Все тесты зелёные, типы проходят проверку
- [ ] AMS отключён по умолчанию (`ams.enabled=false`)
- [ ] При `ams.enabled=false` AMS ресурсы возвращают null или ошибку

## План отката

- Rollback изменений операции и узлов в случае проблем
- AMS клиент изолирован - можно отключить без влияния на generator
- Feature flag `ams.enabled=false` отключает всю AMS функциональность

---

**Этот план самодостаточен и покрывает все аспекты имплементации тикета 603. Можно начинать кодить по порядку из чеклиста.**