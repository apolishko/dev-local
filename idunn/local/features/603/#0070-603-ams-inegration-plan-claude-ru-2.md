# План реструктуризации AMS интеграции в Gateway архитектуру

## Контекст

Имеем реализованную AMS интеграцию с монолитным `AMSRabbitMQClient`, которую нужно переструктурировать в правильный gateway паттерн согласно архитектуре проекта (`comfyUI2`, `renderFarm`).

## Что УЖЕ реализовано и можно использовать

### ✅ Готовые компоненты (переносим без изменений):
1. **Схемы YAML**: `documentation/api/schemas/remote/ams/{request.yaml,response.yaml}` - корректны
2. **Конфигурация**: 
   - `Config.ts` - поле `ams.responseExchange?: string | null` добавлено
   - `environment.ts` - чтение конфига добавлено
   - `config/default.json` - секция ams готова
3. **OperationServices**: `requestContext?: RequestContext` добавлен
4. **Per-request RPC алгоритм**: в `AMSRabbitMQClient` - логика корректна, нужно только перенести

### ✅ Готовая бизнес-логика (переносим с адаптацией):
1. **Формирование payload**: метод `buildRequestPayload()` из `AMSRabbitMQClient`
2. **Выбор вариаций**: функции `selectAssetVariation()`, `selectImageVariation()`, `selectVideoVariation()` из `storage.ts`
3. **HTTP скачивание**: axios логика из `getAMSResourceViaRabbitMQ()`
4. **Обработка ошибок**: логирование и error handling готовы

## Пошаговый план реструктуризации

### 1. Создать Gateway структуру

```bash
mkdir -p src/server/gateways/ams/{internal,request,response,types}
```

**Файлы для создания:**
- `src/server/gateways/ams/internal/rpc.ts`
- `src/server/gateways/ams/request/requestHandler.ts`
- `src/server/gateways/ams/response/resultWaiter.ts`
- `src/server/gateways/ams/response/parseResultMessage.ts`
- `src/server/gateways/ams/types/index.ts`
- `src/server/gateways/ams/index.ts`

### 2. Создать internal/rpc.ts (приватный RPC транспорт)

**Источник**: `src/server/services/ams/rabbitMQClient.ts`

**Что перенести:**
- Класс переименовать: `AMSRabbitMQClient` → `AMSRPCTransport`
- Методы оставить: `initialize()`, `createExclusiveQueue()`, `setupReplyConsumer()`, `cleanupRequest()`
- Убрать бизнес-логику: `buildRequestPayload()` перенести в `requestHandler.ts`
- Сделать интерфейс проще: только чистый RPC (send + wait)

**Новый интерфейс:**
```typescript
export class AMSRPCTransport {
  async sendAndWait(payload: unknown, timeoutMs: number): Promise<unknown>
}
```

### 3. Создать request/requestHandler.ts

**Что реализовать:**
- Импорт сгенерированных типов: `import type { Request } from '../types'`
- AJV валидация request payload
- Формирование payload (перенести `buildRequestPayload()` из старого клиента)
- Вызов `internal/rpc.ts` для отправки

**Функция:**
```typescript
export async function sendAssetRequest(
  assetId: string, 
  context?: { tenantId?: string; userEmail?: string }
): Promise<unknown>
```

### 4. Создать response/parseResultMessage.ts

**Что реализовать:**
- Импорт сгенерированных типов: `import type { Response } from '../types'`
- AJV валидация response payload
- Нормализация: проверка `success`, `requestId`, `asset`, `variations[]`
- Type guards для response

**Функция:**
```typescript
export function parseAMSResponse(rawResponse: unknown): AMSResponse
```

### 5. Создать response/resultWaiter.ts

**Что реализовать:**
- Обертка над `internal/rpc.ts` + `parseResultMessage.ts`
- Удобный API для получения результата

**Функция:**
```typescript
export async function waitForAssetResponse(
  assetId: string,
  context?: RequestContext
): Promise<AMSAsset>
```

### 6. Создать types/index.ts

**Что реализовать:**
- Переэкспорт сгенерированных типов из `src/jsonSchemas/remote/ams/*`
- Дополнительные типы для internal API

```typescript
export type { Request, Response } from 'jsonSchemas/remote/ams'
export type AMSAsset = Response['asset']
export type AMSVariation = AMSAsset['variations'][0]
```

### 7. Создать index.ts (публичный Gateway API)

**Что реализовать:**
- Высокоуровневые функции для ResourceStorage
- Перенести логику выбора вариаций из `storage.ts`
- Добавить axios скачивание

**API:**
```typescript
export async function requestAssetById(
  assetId: string, 
  context?: RequestContext
): Promise<AMSAsset>

export function selectVariation(
  asset: AMSAsset, 
  options: {
    kind: 'image' | 'video'
    mode?: 'preview' | 'order' 
    scalingFactor?: number
    preferProRes?: boolean
  }
): AMSVariation | null

export async function downloadVariationBuffer(
  url: string, 
  timeoutMs?: number
): Promise<Buffer>
```

### 8. Обновить ResourceStorage

**Файл**: `src/server/services/resources/storage.ts`

**Что изменить:**
1. **Удалить импорты AMQP**: убрать `require('../../mq/listeners/ams')`
2. **Добавить импорт gateway**: `import * as amsGateway from '../../gateways/ams'`
3. **Переписать `getAMSResourceViaRabbitMQ()`:**

```typescript
// БЫЛО:
const amsClient = getAMSClient();
const response = await amsClient.requestAssetMetadata({...});

// СТАЛО:  
const asset = await amsGateway.requestAssetById(assetId, requestContext);
const variation = amsGateway.selectVariation(asset, {
  kind: resourceType === 'image' ? 'image' : 'video',
  mode: 'preview',
  scalingFactor
});
const buffer = await amsGateway.downloadVariationBuffer(variation.url);
```

4. **Удалить функции**: `getAMSClient()`, `selectAssetVariation()`, `selectImageVariation()`, `selectVideoVariation()` - перенести в gateway

### 9. Удалить старые файлы

**Удалить после переноса:**
- `src/server/services/ams/rabbitMQClient.ts` 
- `src/server/mq/listeners/ams.ts` (если не используется для других целей)

**Из `src/server/mq/index.ts` убрать:**
```typescript
// Удалить эти строки:
import { initializeAMSClient } from './listeners/ams';
await initializeAMSClient(amqpConnection.getDefaultChannel(), config.get());
```

### 10. Обновить тесты

**Создать новые тесты:**
- `test/unit/server/gateways/ams/internal/rpc.test.ts`
- `test/unit/server/gateways/ams/response/parseResultMessage.test.ts` 
- `test/unit/server/gateways/ams/index.test.ts`

**Перенести логику из старых тестов:**
- `test/unit/server/services/ams/rabbitMQClient.test.ts` → RPC тесты
- `test/unit/server/services/resources/storage.ams.test.ts` → Gateway API тесты

## Критические детали реализации

### Инициализация Gateway
- Gateway НЕ создает глобальных listeners
- RPC transport инициализируется lazy при первом вызове
- Использует `getDefaultChannel()` из `src/server/mq/connection.ts`

### Обработка per-request очередей
- Каждый `sendAndWait()` создает exclusive очередь
- После ответа или таймаута - обязательная очистка (`cancel` + `deleteQueue`)
- Корреляция по `requestId` в JSON payload, НЕ по AMQP `correlationId`

### Вариант A vs B (queue vs exchange)
- Если `config.ams.responseExchange` не задан - используем Вариант A (`replyTo: { queue }`)
- Если задан - используем Вариант B (`replyTo: { exchangeName, routingKey }`)
- Логика в `internal/rpc.ts`

### Логирование
- Везде использовать `import logger from '../../../services/logger'`
- Логи: отправка запроса, получение ответа, ошибки, таймауты
- НЕ использовать `console.*`

### Ошибки
- Gateway функции бросают типизированные исключения
- ResourceStorage ловит и оборачивает в контекстные ошибки
- Fallback логика остается в ResourceStorage (при `ams.enabled=false`)

## Проверка готовности

### ✅ Чек-лист файлов:
- [ ] `src/server/gateways/ams/internal/rpc.ts` - создан, RPC логика
- [ ] `src/server/gateways/ams/request/requestHandler.ts` - создан, формирует payload
- [ ] `src/server/gateways/ams/response/resultWaiter.ts` - создан, обертка RPC
- [ ] `src/server/gateways/ams/response/parseResultMessage.ts` - создан, валидация ответов  
- [ ] `src/server/gateways/ams/types/index.ts` - создан, переэкспорт типов
- [ ] `src/server/gateways/ams/index.ts` - создан, публичный API
- [ ] `src/server/services/resources/storage.ts` - обновлен, использует gateway API

### ✅ Чек-лист поведения:
- [ ] ResourceStorage не импортирует AMQP модули  
- [ ] Нет глобальных consumers на общую очередь ответов
- [ ] Per-request exclusive очереди создаются и удаляются
- [ ] Таймауты с обязательной очисткой ресурсов
- [ ] Логирование через winston, не console.*
- [ ] Тесты покрывают RPC, parsing, gateway API

### ✅ Критерии приемки:
- [ ] `npm run typecheck` проходит без ошибок
- [ ] Тесты проходят  
- [ ] AMS интеграция готова к включению через `ams.enabled=true`
- [ ] Архитектура соответствует паттерну `comfyUI2/renderFarm`

## Технические заметки

### Миграция зависимостей
- `uuid` - уже в зависимостях, используем для `requestId`
- `axios` - уже в зависимостях, для HTTP скачивания
- `amqplib` - только в gateway, НЕ в ResourceStorage
- Сгенерированные типы - импортируем из `src/jsonSchemas/remote/ams/*`

### Совместимость
- Обратная совместимость: графы с `{ resourceRef }` не изменяются
- Новая функциональность: графы с `{ ams }` используют gateway
- Fallback: при `ams.enabled=false` возвращаем null (как сейчас)

### Производительность  
- Lazy инициализация RPC transport
- Переиспользование MQ channel (не создаем новые подключения)
- HTTP timeout 30s для axios (как сейчас)
- MQ timeout из конфига (как сейчас)

---

**Этот план исчерпывающий и ready-to-execute. В новой conversation достаточно выполнять шаги 1-10 последовательно.**