# Тикет 603: Рефакторинг AMS интеграции v2 - Упрощение архитектуры

## Цель рефакторинга

Убрать искусственные концепции `context` и `resourceType`, которых нет в реальной AMS системе, и перейти на автоматическое определение типов по MIME-типам вариаций.

### Проблемы текущей реализации
1. **`context { tenantId, userEmail }`** - наша обвязка, не требование AMS
2. **AMS `resourceType: 'asset'`** - бессмысленный хардкод в AMS Gateway, которого нет в AMS API  
3. **Искусственный маппинг** `kind: resourceType === 'image' ? 'image' : 'video'` в ResourceStorage
4. **Путаница между двумя разными `resourceType`:**
   - **Load Resource `resourceType`** (`'image'|'binary'|'imageSequence'`) - InteroperationType для графа операций ✅ **НУЖЕН**
   - **AMS `resourceType: 'asset'`** - хардкод строка в AMS Gateway ❌ **НЕ НУЖЕН**

### Цели упрощения
- ✅ Убрать `context` полностью - не передаваем в wire, не используем в логике
- ✅ Убрать **AMS** `resourceType: 'asset'` - бессмысленный хардкод
- ✅ **СОХРАНИТЬ** Load Resource `resourceType` - это InteroperationType, нужен для операции
- ✅ Заменить искусственный маппинг на auto-detection по `mimeType` 
- ✅ Упростить AMS Gateway API
- ✅ Сохранить все функциональность и тесты

## План изменений по файлам

### 1. Упрощение типов и схем

#### `src/types/gateways/ams/request.ts`
**Было:**
```typescript
export type AMSRequestContext = {
  tenantId?: string;
  userEmail?: string;
};

export type AMSSearchRequest = {
  assetId: string;
  resourceType: string;  // ← Этот хардкод 'asset' убираем
  context?: AMSRequestContext;
};
```

**Станет:**
```typescript
export type AMSSearchRequest = {
  assetId: string;
};
```

#### `src/server/gateways/ams/types/index.ts`
**Убираем:**
- `AMSRequestContext`
- AMS `resourceType` поле (хардкод 'asset')

**Сохраняем:**
- `AMSAsset`, `AMSVariation` - без изменений
- `VariationSelectionOptions` - упрощаем

#### `src/jsonSchemas/gateways/ams/request.ts`
**Убираем:**
- `context` схему
- AMS `resourceType` поле (хардкод 'asset')
- Валидация `tenantId`, `userEmail`

### 2. Упрощение AMS Gateway

#### `src/server/gateways/ams/index.ts`
**Было:**
```typescript
import type { RequestContext } from '../../types/OperationServices';  // ← УБИРАЕМ импорт

export async function requestAssetById(
  assetId: string,
  context?: RequestContext  // ← УБИРАЕМ параметр
): Promise<AMSAsset>

export function selectVariation(
  asset: AMSAsset,
  options: {
    kind: 'image' | 'video';
    mode: VariationSelectionMode;
    scalingFactor?: number;
    preferProRes?: boolean;
  }
): AMSVariation | null
```

**Станет:**
```typescript
export async function requestAssetById(assetId: string): Promise<AMSAsset>

export function selectVariation(
  asset: AMSAsset,
  options: {
    mode: VariationSelectionMode;
    scalingFactor?: number; 
    preferProRes?: boolean;
  }
): AMSVariation | null
```

**Новая логика selectVariation:**
```typescript
export function selectVariation(asset: AMSAsset, options: VariationSelectionOptions): AMSVariation | null {
  const { mode, scalingFactor, preferProRes } = options;
  
  // Пробуем найти image вариации первыми (более универсальные)
  const imageVariations = asset.variations.filter(v => v.mimeType.startsWith('image/'));
  if (imageVariations.length > 0) {
    return selectImageVariation(imageVariations, scalingFactor);
  }
  
  // Если нет image, пробуем video
  const videoVariations = asset.variations.filter(v => v.mimeType.startsWith('video/'));
  if (videoVariations.length > 0) {
    return selectVideoVariation(videoVariations, mode, scalingFactor, preferProRes);
  }
  
  // Fallback: первая доступная вариация
  return asset.variations[0] || null;
}
```

#### `src/server/gateways/ams/request/requestHandler.ts`
**Убираем:**
- Всю логику с `context`
- `hasContext`, `contextTenantId` из логов
- `payloadWithContext` логику

**Упрощаем до:**
```typescript
const basePayload: AMSMessage['payload'] = {
  type: 'searchAssets',
  requestId,
  payload: {
    offset: 0,
    limit: 1,
    query: {
      field: 'id',
      operator: 'equals', 
      value: searchRequest.assetId,
    },
  },
};
```

### 3. Обновление ResourceStorage

#### `src/server/services/resources/storage.ts`
**Было:**
```typescript
async function getAMSResourceViaRabbitMQ(
  assetId: string,
  resourceType: string,  // ← AMS resourceType (хардкод 'asset') УБИРАЕМ
  scalingFactor?: number,
  requestContext?: { tenantId?: string; userEmail?: string }  // ← context УБИРАЕМ
): Promise<RuntimeValue | null>
```

**Станет:**
```typescript
async function getAMSResourceViaRabbitMQ(
  assetId: string,
  scalingFactor?: number
): Promise<RuntimeValue | null>
```

**ВАЖНО:** Load Resource операция **СОХРАНЯЕТ** свой `resourceType` (InteroperationType):
```typescript
// В Load Resource операции (ОСТАЕТСЯ БЕЗ ИЗМЕНЕНИЙ):
const resource = await services.resourceStorage.get(
  resourceReference,
  { type: resourceType } as InteroperationType,  // ← НУЖЕН! Это InteroperationType
  config.scalingFactor
);
```

**Упрощение логики:**
```typescript
async function getAMSResourceViaRabbitMQ(
  assetId: string,
  scalingFactor?: number
): Promise<RuntimeValue | null> {
  const amsGateway = (await import('../../gateways/ams'));
  
  try {
    // Request asset from AMS (без context)
    const asset = await amsGateway.requestAssetById(assetId);
    
    // Select best variation (автоматический выбор по MIME)
    const variation = amsGateway.selectVariation(asset, {
      mode: 'preview',
      scalingFactor,
      preferProRes: config.get().ams.preferProResForOrders,
    });

    if (!variation) {
      throw new Error(`No suitable variation found for asset ${assetId}`);
    }
    
    // Download variation content  
    const buffer = await amsGateway.downloadVariationBuffer(variation.url);
    return await ensureImageProperties(buffer);
  } catch (error) {
    throw new Error(`AMS asset ${assetId} failed: ${(error as Error).message}`);
  }
}
```

**Изменения в вызове:**
```typescript
// БЫЛО (передавали AMS resourceType):
return await getAMSResourceViaRabbitMQ(
  resourceReference.ams,
  type.type,  // ← InteroperationType передавался в AMS (НЕ НУЖНО)
  scalingFactor,
  requestContext
);

// СТАНЕТ (не передаем InteroperationType в AMS):
return await getAMSResourceViaRabbitMQ(
  resourceReference.ams,
  scalingFactor
);
// InteroperationType остается только на уровне ResourceStorage для валидации результата
```

### 4. Обновление конфигураций и схем

#### `config/default.json` и `config/test.json`
**Без изменений** - AMS конфиг остается как есть

#### `documentation/api/schemas/remote/ams/request.yaml`
**Было:** (содержит context)
```yaml
# Схема с context полями
context:
  type: object
  properties:
    tenantId:
      type: string
    userEmail:
      type: string
```

**Упрощаем схему запроса:**
```yaml
AMSSearchRequest:
  type: object
  required: [assetId]
  properties:
    assetId:
      type: string
      description: AMS asset identifier
# Убираем все context поля
```

#### `src/server/tools/build-api/exportSchemas/exports/ams.yaml`
**Обновляем экспорт** - убираем context и resourceType из схем

### 5. Обновление тестов

#### `test/server/integration/ams.test.ts`
**Упрощаем вызовы:**
```typescript
// Было:
const asset = await amsGateway.requestAssetById('image-asset-001', {
  tenantId: 'test-tenant',
  userEmail: 'test@example.com'
});

// Станет:
const asset = await amsGateway.requestAssetById('image-asset-001');
```

#### `test/support/server/fakeRemotes/fakeAMS.ts`
**Упрощаем обработку:**
- Убираем проверку `context` полей
- Упрощаем логирование
- Убираем `context` из mock данных

#### `test/support/server/fakeRemotes/fakeAMS/requestSchema.yaml`
**Было:** (содержит context поля)
```yaml
context:
  type: object
  properties:
    tenantId:
      type: string
    userEmail:
      type: string
```

**Упрощаем схему - УБИРАЕМ context:**
```yaml
type: object
required: [type, requestId, payload]
properties:
  type:
    type: string
    enum: [searchAssets]
  requestId:
    type: string
  payload:
    type: object
    required: [offset, limit, query]
    properties:
      offset:
        type: integer
        minimum: 0
      limit:
        type: integer
        minimum: 1
      query:
        type: object
        required: [field, operator, value]
        properties:
          field:
            type: string
            enum: [id]
          operator:
            type: string
            enum: [equals]
          value:
            type: string
# Убираем весь context блок!
```

### 6. Обновление типов OperationServices

#### `src/server/types/OperationServices/index.ts` 
**❌ УДАЛЯЕМ RequestContext полностью:**
```typescript  
// УБИРАЕМ:
export type RequestContext = {
  tenantId?: string;
  userEmail?: string;
};
```

### 7. ✅ Load Resource операция остается БЕЗ ИЗМЕНЕНИЙ

#### `src/graphics/server/operations/loadResource.ts`
**ВАЖНО: НИКАКИХ ИЗМЕНЕНИЙ!** 

Load Resource операция **СОХРАНЯЕТ** свою текущую сигнатуру:
```typescript
const [resourceType, ref, source] = args;  // ← resourceType ОСТАЕТСЯ
// resourceType здесь = InteroperationType ('image'|'binary'|'imageSequence')
// Это НЕ тот же resourceType что в AMS ('asset')!

const resource = await services.resourceStorage.get(
  resourceReference,
  { type: resourceType } as InteroperationType,  // ← НУЖЕН для операции!
  config.scalingFactor
);
```

#### `src/platform/generic/data/operations/loadResource.ts`
**Без изменений** - описание операции остается с 3 аргументами

### Различие между двумя resourceType:

| Место | Тип | Значения | Назначение | Действие |
|-------|-----|----------|------------|----------|
| **Load Resource операция** | `InteroperationType` | `'image'`, `'binary'`, `'imageSequence'` | Типизация графа операций | ✅ **СОХРАНЯЕМ** |
| **AMS Gateway** | `string` | `'asset'` (хардкод) | ??? (бессмысленно) | ❌ **УБИРАЕМ** |

## Ожидаемые результаты

### ✅ Упрощения
1. **Убрали 50+ строк** искусственного кода с `context` и `resourceType`
2. **Упростили API** - `requestAssetById(assetId)` вместо 3 параметров
3. **Автоматическое определение типа** по MIME вместо hardcode
4. **Меньше типов и схем** - проще поддерживать

### ✅ Сохранили функциональность  
1. **Все тесты проходят** после обновления
2. **AMS интеграция работает** без потери возможностей
3. **Wire-совместимость** с Freya сохранена
4. **Селекторы вариаций** работают лучше (auto-detect)

### ✅ Архитектурные улучшения
1. **Убрали концепции**, которых нет в AMS
2. **Следуем принципу MIME-based logic**
3. **Упрощенная отладка** и логирование
4. **Готовность к новым типам ассетов** (audio, документы и т.д.)

## Последовательность реализации

1. **Обновить типы** (request.ts, types/index.ts)
2. **Упростить AMS Gateway** (index.ts, requestHandler.ts)  
3. **Обновить ResourceStorage** (storage.ts)
4. **Упростить схемы** (YAML файлы)
5. **Обновить тесты** (ams.test.ts, fakeAMS.ts)
6. **Проверить сборку** и прохождение тестов

## Критерии готовности

- ✅ Все тесты проходят
- ✅ Сборка без ошибок типов
- ✅ AMS интеграция работает через RabbitMQ
- ✅ Селекторы вариаций определяют тип автоматически
- ✅ Убраны все упоминания `context` и `resourceType` из AMS кода
- ✅ Wire-совместимость с Freya сохранена