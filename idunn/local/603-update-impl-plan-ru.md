# План реализации 603 Update - AMS Gateway Improvements

## Обзор

Обновляем AMS Gateway для использования единого примитива результата из `src/utils/result.ts`, адаптивной логики выбора высот на основе мастер-файла, и добавляем OTEL мониторинг.

## Контекст изменений

**Замечания команды:**
- Использовать общий примитив `{ success: true, data: AMSResponseSuccess }` вместо самодельного `{ ok: true, ... }`
- Заменить фиксированную высоту 1080 на высоту мастер-файла из ассета
- Добавить OTEL трейсинг для запросов к AMS

**Принципы:**
- Никаких breaking changes для внешних потребителей
- Сохранение всех существующих тестов
- Использование только существующей типизации и валидации
- Никаких изменений YAML схем

---

## Пошаговый план реализации

### Шаг 1: Добавление OTEL span name

**Файл:** `src/server/otel/spanNames.ts`

**Действие:** Добавить новый span name в union type

**Точные изменения:**
```typescript
export type OtelSpanName =
  | 'run_template'
  | 'run_operation' 
  | 'template_runner_collapsed'
  | 'template_run_registered'
  | 'cache_read'
  | 'cache_write'
  | 'ams_request_asset';  // <- ДОБАВИТЬ ЭТУ СТРОКУ
```

---

### Шаг 2: Рефакторинг parseResultMessage.ts

**Файл:** `src/server/gateways/ams/response/parseResultMessage.ts`

#### 2.1. Обновить импорты

**ЗАМЕНИТЬ существующие импорты:**
```typescript
// СТАРЫЕ импорты (строки 1-5)
import Ajv from 'ajv';
import { amsResponseSchema, amsResponseSuccessSchema, amsResponseErrorSchema }
  from '../../../../jsonSchemas/gateways/ams/response';
import type { AMSResponse, AMSResponseSuccess, AMSResponseError } from '../types';
import logger from '../../../services/logger';
```

**НА новые импорты:**
```typescript
import Ajv from 'ajv';
import { amsResponseSchema, amsResponseSuccessSchema, amsResponseErrorSchema }
  from '../../../../jsonSchemas/gateways/ams/response';
import type { AMSResponse, AMSResponseSuccess, AMSResponseError } from '../types';
import type { ResultSuccess, ResultError } from '../../../../utils/result';
import { success, error } from '../../../../utils/result';
import logger from '../../../services/logger';
```

#### 2.2. Изменить сигнатуру parseSuccessResponse

**ЗАМЕНИТЬ функцию (строки 38-65):**
```typescript
function parseSuccessResponse(response: AMSResponse): { ok: true; data: AMSResponseSuccess } {
```

**НА:**
```typescript
function parseSuccessResponse(response: AMSResponse): ResultSuccess<AMSResponseSuccess> {
```

**ЗАМЕНИТЬ return statement (строка 64):**
```typescript
return { ok: true, data: successResponse };
```

**НА:**
```typescript
return success(successResponse);
```

#### 2.3. Изменить сигнатуру parseErrorResponse

**ЗАМЕНИТЬ функцию (строки 67-82):**
```typescript
function parseErrorResponse(response: AMSResponse): { ok: false; error: AMSResponseError } {
```

**НА:**
```typescript
function parseErrorResponse(response: AMSResponse): ResultError<AMSResponseError> {
```

**ЗАМЕНИТЬ return statement (строка 81):**
```typescript
return { ok: false, error: errorResponse };
```

**НА:**
```typescript
return error(errorResponse);
```

#### 2.4. Изменить сигнатуру parseAMSResponse

**ЗАМЕНИТЬ функцию (строки 84-85):**
```typescript
export function parseAMSResponse(rawResponse: unknown):
  { ok: true; data: AMSResponseSuccess } | { ok: false; error: AMSResponseError } {
```

**НА:**
```typescript
export function parseAMSResponse(rawResponse: unknown):
  ResultSuccess<AMSResponseSuccess> | ResultError<AMSResponseError> {
```

#### 2.5. Удалить type guards

**ПОЛНОСТЬЮ УДАЛИТЬ функции (строки 100-106):**
```typescript
export function isAMSSuccessResponse(response: { ok: boolean }): response is { ok: true; data: AMSResponseSuccess } {
  return response.ok === true;
}

export function isAMSErrorResponse(response: { ok: boolean }): response is { ok: false; error: AMSResponseError } {
  return response.ok === false;
}
```

---

### Шаг 3: Обновление resultWaiter.ts

**Файл:** `src/server/gateways/ams/response/resultWaiter.ts`

#### 3.1. Обновить импорты

**ЗАМЕНИТЬ импорт (строка 5):**
```typescript
import { parseAMSResponse, isAMSSuccessResponse } from './parseResultMessage';
```

**НА:**
```typescript
import { parseAMSResponse } from './parseResultMessage';
import { isSuccess } from '../../../../utils/result';
```

#### 3.2. Заменить проверку результата

**НАЙТИ строку (~48):**
```typescript
if (!isAMSSuccessResponse(parsedResponse)) {
```

**ЗАМЕНИТЬ НА:**
```typescript
if (!isSuccess(parsedResponse)) {
```

#### 3.3. Обновить обращение к error data

**НАЙТИ строку (~49):**
```typescript
const errorMessage = parsedResponse.error.error.message || 'AMS request failed with no error message';
```

**ЗАМЕНИТЬ НА:**
```typescript
const errorMessage = parsedResponse.data.error.message || 'AMS request failed with no error message';
```

**НАЙТИ все места где используется `parsedResponse.error` и ЗАМЕНИТЬ на `parsedResponse.data`:**
- В логах error (~50-55)
- В обращениях к requestId и другим полям

#### 3.4. Обновить обращение к success data

**НАЙТИ строку (~62-66) где возвращается успешный результат:**
```typescript
return parsedResponse.data.payload.asset;
```

**ЗАМЕНИТЬ НА:**
```typescript
return parsedResponse.data.payload.asset;
```
(остается без изменений, так как структура совпадает)

---

### Шаг 4: Обновление index.ts

**Файл:** `src/server/gateways/ams/index.ts`

#### 4.1. Добавить импорт OTEL

**ДОБАВИТЬ после строки 11:**
```typescript
import otel from '../../otel/index';
```

#### 4.2. Добавить функцию getMasterHeight

**ДОБАВИТЬ после строки 84 (перед selectImageVariation):**
```typescript
/**
 * Get master file height from available variations
 * Uses maximum height among all variations, fallback to 1080 if none available
 */
function getMasterHeight(variations: AMSVariation[]): number {
  const heights = variations.map(v => v.height || 0).filter(h => h > 0);
  return heights.length > 0 ? Math.max(...heights) : 1080;
}
```

#### 4.3. Обновить selectImageVariation

**НАЙТИ строку (~94):**
```typescript
const targetHeight = Math.round(1080 * scalingFactor);
```

**ЗАМЕНИТЬ НА:**
```typescript
const masterHeight = getMasterHeight(variations);
const targetHeight = Math.round(masterHeight * scalingFactor);
```

#### 4.4. Обновить selectBestVariationByHeight

**НАЙТИ строку (~150):**
```typescript
const targetHeight = Math.round(1080 * scalingFactor);
```

**ЗАМЕНИТЬ НА:**
```typescript
const masterHeight = getMasterHeight(variations);
const targetHeight = Math.round(masterHeight * scalingFactor);
```

#### 4.5. Добавить OTEL обёртку для requestAssetById

**ЗАМЕНИТЬ всю функцию requestAssetById (строки 18-32):**
```typescript
export async function requestAssetById(
  assetId: string
): Promise<AMSAsset> {
  const searchRequest: AMSSearchRequest = {
    assetId,
  };

  const amsConfig = config.get().ams;

  return waitForAssetResponse(searchRequest, {
    requestQueue: amsConfig.requestQueue,
    responseExchange: amsConfig.responseExchange,
    timeout: amsConfig.timeout,
  });
}
```

**НА:**
```typescript
export async function requestAssetById(
  assetId: string
): Promise<AMSAsset> {
  const searchRequest: AMSSearchRequest = {
    assetId,
  };

  const amsConfig = config.get().ams;

  return otel.reportSpan(
    'ams_request_asset',
    {
      assetId,
      requestQueue: amsConfig.requestQueue,
      responseExchange: amsConfig.responseExchange,
      timeout: amsConfig.timeout,
    },
    async () => {
      return waitForAssetResponse(searchRequest, {
        requestQueue: amsConfig.requestQueue,
        responseExchange: amsConfig.responseExchange,
        timeout: amsConfig.timeout,
      });
    }
  );
}
```

---

## Порядок выполнения

1. **Шаг 1** - добавить OTEL span name (простое добавление строки)
2. **Шаг 2** - рефакторить parseResultMessage.ts (типы и примитивы)
3. **Шаг 3** - обновить resultWaiter.ts (проверки результата)
4. **Шаг 4** - обновить index.ts (логика высот + OTEL)

## Проверка результата

После всех изменений:

1. **Типы компилируются:** `npm run build-json-schema-types && npm run typecheck`
2. **Тесты проходят:** `npm run test-ams-integration`
3. **Линтер чист:** `npm run lint`

## Важные заметки

- **НЕ изменять** YAML схемы в `documentation/api/schemas/`
- **НЕ изменять** тесты в `test/server/integration/ams.test.ts`
- **НЕ изменять** типы в `src/types/gateways/ams/`
- Все изменения **только в указанных файлах**
- Сохранить все существующие комментарии и документацию
- Поддерживать консистентный стиль кода (eslint правила)

## Технические детали

- `getMasterHeight` возвращает `number`, всегда > 0
- OTEL span содержит все параметры конфигурации AMS
- result.ts примитивы полностью заменяют самодельные `{ ok: ... }`
- Структура `parsedResponse.data` идентична старому `parsedResponse.data`
- Error case: `parsedResponse.data` содержит `AMSResponseError`
- Success case: `parsedResponse.data` содержит `AMSResponseSuccess`