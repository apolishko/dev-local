### План рефакторинга AMS-интеграции (wire-контракт + терминология request-reply)

Цель: избавиться от расплывчатого термина «RPC», синхронизировать wire-контракт с AMS (Freya) и привести код к чёткой модели request-reply через per-request exclusive reply queue. На проводе — строго структуры `IRabbitMessage` / `IRabbitResponse` / `IRabbitError`. Внутри нашего gateway — опциональная нормализация результата.

---

### Почему меняем (КРИТИЧНО для production AMS)
- **Wire-контракт несовместим**: Проверка кода Freya показала, что production AMS использует ТОЛЬКО `replyTo: { exchangeName, routingKey }`. Наш текущий код с `replyTo: { queue }` НЕ РАБОТАЕТ с реальным AMS.
- **Поле `success` отсутствует**: В `IRabbitResponse`/`IRabbitError` нет поля `success: boolean` — это наше внутреннее изобретение, которого нет на проводе.
- **Терминология**: «RPC» не соответствует архитектуре Freya, где используется «request-reply через per-request exclusive reply queue».
- **Единообразие**: критично для отладки интеграции — мы должны говорить на одном языке с AMS.

**ИТОГ**: Это НЕ рефакторинг ради красоты — это исправление багов для работы с production AMS. Без этих изменений интеграция нефункциональна.

---

### Новые принципы
- **Терминология в коде и логах**: «request-reply», «per-request exclusive reply queue», «send-and-wait» вместо «RPC».
- **Wire-контракт (на проводе)**:
  - Request: `{ type, requestId, replyTo: { exchangeName, routingKey }, payload, context? }`
  - Success: `{ type, requestId, payload }`
  - Error: `{ type, requestId, error: { code, message, details? } }`
- **Внутренний API gateway** (опционально): нормализуем в `{ ok: true, data } | { ok: false, error }` для удобства вызывающего кода. Но на проводе — без `success`.

- **Вариации AMS**: в `payload.asset.variations[]` храним только: `url`, `height`, `mimeType`. Больше никаких полей не нужно.
- **Выбор вариации**: определяем тип/формат по `mimeType`, затем выбираем ближайший `height`.
  - ProRes: `mimeType.includes('video/quicktime')`  
  - MP4: `mimeType.includes('video/mp4')`
  - JPEG: `mimeType.includes('image/jpeg')`

---

### Изменения по файлам (что и зачем)

1) `documentation/api/schemas/remote/ams/request.yaml`
- Привести к форме Freya:
  - Обязательные поля: `type: string`, `requestId: string`, `replyTo: { exchangeName: string; routingKey: string }`, `payload: object`.
  - `context?: { tenantId?: string; userEmail?: string }` оставить опционально.
  - Убрать альтернативы вида `replyTo.queue`. Мы используем direct-exchange + routingKey, как в Freya.

2) `documentation/api/schemas/remote/ams/response.yaml`
- Убрать поле `success`.
- Описать два варианта:
  - `amsResponseSuccess` → `{ type, requestId, payload: { ...asset/variations... } }`
  - `amsResponseError` → `{ type, requestId, error: { code, message, details? } }`
- При желании можно добавить третий «объединяющий» тип `amsResponse` через `oneOf`.

- Для `payload.asset.variations[]` задать схему:
  - required: `url: string`, `height: number`, `mimeType: string`
  - никаких дополнительных полей типа `codec`/`container` - всё определяется по `mimeType`.

3) `src/server/tools/build-api/types/exports/ams.yaml`
- Обновить экспорт генерируемых типов, например:
  - `amsResponseSuccess` → `src/types/gateways/ams/responseSuccess.ts`
  - `amsResponseError` → `src/types/gateways/ams/responseError.ts`
  - (опционально) `amsResponse` (union) → `src/types/gateways/ams/response.ts`

4) Автогенерация
- Запуск: `npm run build-json-schema-types`.
- Будут сгенерированы TS-типы (`src/types/gateways/ams/*`) и JSON-схемы для рантайм-валидации (`src/jsonSchemas/gateways/ams/*`).

5) `src/server/gateways/ams/internal/rpc.ts` → Переименовать в `internal/requestReply.ts`
- Переименовать экспорт/класс/функции: убрать «RPC» в пользу `RequestReply` или `sendAndWait`.
- В логах заменить «rpc» → «request-reply».
- Семантика та же: создаём per-request reply-очередь (или пару exchange/binding), отправляем, ждём `requestId`, делаем cleanup.

6) `src/server/gateways/ams/response/parseResultMessage.ts`
- Парсить два варианта ответа: `payload` ИЛИ `error`.
- Валидация против новых схем: `amsResponseSuccess`/`amsResponseError` (или union `amsResponse`).
- На выходе gateway может вернуть нормализованный результат `{ ok: true, data } | { ok: false, error }`.

7) `src/server/gateways/ams/index.ts`
- Обновить импорты под переименование `internal/requestReply.ts`.
- Экспортировать новые типы ответов.
- (Если было) убрать локальные дубли `RequestContext` и импортировать из `src/server/types/OperationServices`.

8) `src/server/services/resources/storage.ts`
- Логика не меняется по сути. Обновить обработку ошибок под новую форму ответа gateway (без `success`).

9) Конфиг `config/default.json`
- Убедиться, что есть `ams.requestQueue` и `ams.responseExchange` (имя direct exchange для ответов). Мы создаём временную эксклюзивную очередь и биндим её на этот exchange по уникальному `routingKey`.

10) Тесты
- Обновить моки: ответы эмулировать как `IRabbitResponse`/`IRabbitError`.
- Unit-тесты для `parseResultMessage` (оба варианта).
- Интеграционные: проверка, что отправка идёт в указанный `exchangeName`/`routingKey`, и что reply-очередь корректно чистится.

---

### Примеры сообщений (wire)

Request (к AMS):
```json
{
  "type": "searchAssets",
  "requestId": "c3c6b7a0-...",
  "replyTo": { "exchangeName": "ams.reply", "routingKey": "reply.c3c6b7a0" },
  "payload": { "id": "asset-123" },
  "context": { "tenantId": "t-1", "userEmail": "user@example.com" }
}
```

Success:
```json
{
  "type": "searchAssets",
  "requestId": "c3c6b7a0-...",
  "payload": {
    "asset": {
      "id": "asset-123",
      "type": "video",
      "variations": [
        { "url": "https://...", "height": 1080, "mimeType": "video/mp4" }
      ]
    }
  }
}
```

Error:
```json
{
  "type": "searchAssets",
  "requestId": "c3c6b7a0-...",
  "error": { "code": "NOT_FOUND", "message": "Asset not found" }
}
```

---

### Полные интерфейсы Freya (на сегодня)

Источник: `freya/src/service/rabbit/lib/rabbit-handler.base.ts`

```ts
export interface IRabbitBase {
  type: string;
  requestId: string;
}

export interface IRabbitMessage<T = unknown> extends IRabbitBase {
  payload: T;
  replyTo: {
    exchangeName: string;
    routingKey: string;
  };
}

export interface IRabbitResponse<T = unknown> extends IRabbitBase {
  payload: T;
}

export interface IRabbitError extends IRabbitBase {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

### Что НЕ делаем
- Не импортируем напрямую `IRabbitMessage/IRabbitResponse/IRabbitError` из Freya — зеркалим их через наши YAML-схемы и автогенерацию TS-типов.
- Не оставляем поле `success` на проводе. Внутреннюю нормализацию — пожалуйста, на здоровье.

---

### Миграция и совместимость
- Это breaking-change только относительно нашей WIP-ветки. С продом не конфликтует.
- AMS (Freya) уже работает с такой схемой — сочетаемость улучшится.

---

### План действий (чек-лист)
1. Обновить YAML-схемы `request.yaml`/`response.yaml` под структуру Freya.
2. Пересобрать типы: `npm run build-json-schema-types`.
3. Переименовать `internal/rpc.ts` → `internal/requestReply.ts`, обновить импорты/логи.
4. Обновить `parseResultMessage.ts` под два ответа (payload/error).
5. Пройтись по коду gateway и `ResourceStorage` — убрать упоминания `success`.
6. Обновить тесты (юнит и интеграционные моки).

---

### Открытые вопросы (оставим для развития плана)
- Нужна ли поддержка «fallback» формата `replyTo.queue`? Пока решение: нет, жёстко придерживаемся `{ exchangeName, routingKey }` как у Freya. Если появится кейс — расширим схему через `oneOf`.
- Настройка exchange для ответов: статический `ams.reply` или динамический? Сейчас: статический в конфиге, уникальный `routingKey` per-request.




---

### Дополнительно: затронутые файлы в тикете 603 (перечень/сверка)

Ниже перечень файлов, которые были затронуты работой по 603, и как это отражено в плане:

- `config/default.json` — добавлены `ams.requestQueue`, `ams.responseExchange`, таймауты. См. раздел про конфиг.
- `documentation/api/schemas/remote/ams/request.yaml` — структура Freya (`type`, `requestId`, `replyTo{exchangeName,routingKey}`, `payload`, `context?`).
- `documentation/api/schemas/remote/ams/response.yaml` — два варианта: `payload` ИЛИ `error`; в вариациях — только `url`, `height`, `mimeType`.
- `src/graphics/browser/operations/loadResource.ts` — сигнатура на 3 аргумента (resourceType, ref, source). Логика AMS не используется в браузере.
- `src/graphics/server/operations/loadResource.ts` — 3 аргумента; валидация `source`; маршрутизация в `resourceStorage.get`.
- `src/graphics/server/operations/selectFrameFromVideo.ts` — удалён `.inputFormat('mp4')` для поддержки ProRes/MOV и др.
- `src/jsonSchemas/gateways/ams/request.ts` — автогенерация из YAML; не редактируем вручную.
- `src/jsonSchemas/gateways/ams/response.ts` — автогенерация; отражает `payload|error`, в вариациях только `url`, `height`, `mimeType`.
- `src/platform/generic/data/nodeClasses/processing/LoadResources/getLoadResourceNodeClass.ts` — добавлен аргумент `source` в `operationCall.args`.
- `src/platform/generic/data/operations/loadResource.ts` — операция принимает 3 аргумента, добавлен `source: 'generator'|'ams'`.
- `src/server/configuration/environment.ts` — прокидывание настроек AMS из окружения в конфиг (если используется).
- `src/server/gateways/ams/index.ts` — публичное API gateway; выбор вариации по `mimeType` и `height`; импорт `RequestContext` из `OperationServices`.
- `src/server/gateways/ams/internal/rpc.ts` — по плану переименовать в `internal/requestReply.ts` и обновить импорты/логику «request-reply».
- `src/server/gateways/ams/request/requestHandler.ts` — сборка и валидация исходящего сообщения по схемам; добавление `replyTo` и `context`.
- `src/server/gateways/ams/response/parseResultMessage.ts` — парсинг `IRabbitResponse|IRabbitError`, нормализация; никаких legacy маппингов.
- `src/server/gateways/ams/response/resultWaiter.ts` — per-request эксклюзивная reply-очередь; корреляция по `requestId`; таймаут/cleanup.
- `src/server/gateways/ams/types/index.ts` — внутренние типы: `AMSAsset`, `AMSVariation{ url,height,mimeType }`, опции выбора по `mimeType` и `height`.
- `src/server/services/resources/storage.ts` — маршрутизация AMS-ресурсов в gateway вместо заглушек.
- `src/server/tools/build-api/exportSchemas/exports/ams.yaml` — экспорт JSON-схем (runtime) для AMS (`request`/`response`).
- `src/server/tools/build-api/types/exports/ams.yaml` — экспорт TS-типов, генерируемых из тех же YAML.
- `src/server/types/Config.ts` — типы конфига дополнены полями AMS (`requestQueue`, `responseExchange`, таймауты).
- `src/server/types/OperationServices/index.ts` — добавлен `requestContext: { tenantId; userEmail }`.
- `src/types/gateways/ams/request.ts` — автогенерация из YAML; актуальная форма запроса.
- `src/types/gateways/ams/response.ts` — автогенерация; `payload|error`, в вариациях только `url`, `height`, `mimeType`.

Примечание: наличие в репозитории `src/server/gateways/ams/internal/rpc.ts` — это «как сейчас». По плану он переименовывается в `internal/requestReply.ts` (см. раздел про переименование) вместе с рефакторингом терминологии и логов.
