## 603 v2: AMS Gateway интеграция (schema-first, per-request RPC) — Детальный и однозначный план

### Ключевые принципы (DO / DON'T)
- DO: реализовать AMS как полноценный gateway по паттерну `src/server/gateways/*` (как `renderFarm`, `comfyUI2`).
- DO: per-request exclusive reply queue (RPC) с корреляцией по `requestId` и авто‑очисткой.
- DO: schema-first — YAML в `documentation/api/schemas/remote/ams/*` → генерация типов → валидация (AJV).
- DO: использовать общий AMQP канал через `src/server/mq/connection.ts#getDefaultChannel()`.
- DO: HTTP‑скачивание вариаций через axios (responseType: 'arraybuffer').
- DON'T: не вызывать AMQP напрямую из `ResourceStorage` — только через gateway API.
- DON'T: не держать глобальных consumers на общую очередь ответов — только per‑request.
- DON'T: не использовать устаревший `sendHTTP`; не логировать через console.*.

### Цели
- Заменить заглушки AMS на рабочую серверную интеграцию через RabbitMQ.
- Вынести логику из монолитного клиента в структурированный `gateway/ams` (request/response/types).
- Поддержать загрузку изображений и видео из AMS, подготовить основу под ProRes/MP4 выбор для следующего тикета.

### Паттерн (ориентиры в коде)
- За основу берём структуру и роли файлов, как у:
  - `src/server/gateways/comfyUI2/*`
  - `src/server/gateways/renderFarm/*`
  - Механика ожидания результата (waiter) переносится на RPC per‑request очередь.

---

## Схемы (schema-first)
- Путь: `documentation/api/schemas/remote/ams/`
  - `request.yaml` (oneOf для replyTo):
    - fields: `type: enum['searchAssets']`, `requestId: string(uuid)`, `replyTo: { queue: string } | { exchangeName: string, routingKey: string }`,
      `payload: { offset:int, limit:int, query: { field:'id', operator:'equals', value:string } }`,
      `context?: { tenantId?: string, userEmail?: string }`;
    - `additionalProperties: false`.
  - `response.yaml`:
    - fields: `requestId: string`, `success: boolean`, `asset?: { id:string, type: 'image'|'video', variations: Variation[], metadata?: object }`, `error?: string|null`;
    - `Variation`: `{ type:'image'|'video', url:string, mimeType?:string, height?:number, container?:'mp4'|'mov'|'prores'|string }`;
    - `additionalProperties: false`.
- Генерация типов: `npm run build-json-schema-types` → `src/jsonSchemas/remote/ams/*`.

---

## Структура gateway/ams (обязательно создать)
- Путь: `src/server/gateways/ams/`
  1) `request/requestHandler.ts`
     - Импорт сгенерённых типов (request), AJV‑валидация.
     - Формирование payload: `{ type:'searchAssets', requestId, replyTo, payload, context }`.
     - Публикация в `config.get().ams.requestQueue` через общий канал (`getDefaultChannel()`), без глобальных consumers.
  2) `response/resultWaiter.ts`
     - Алгоритм RPC (per‑request):
       - `assertQueue('', { exclusive: true, autoDelete: true, durable: false })` → `replyQueue`.
       - (Вариант B по конфигу) `assertExchange(responseExchange,'direct',{ durable:false })` + `bindQueue`.
       - `consume(replyQueue, onMessage)`; фильтр по `requestId`; при первом совпадении → `cancel` + `deleteQueue`.
       - Таймаут (`setTimeout`) с обязательной очисткой очереди/consumer.
  3) `response/parseResultMessage.ts`
     - Импорт сгенерённых типов (response), AJV‑валидация.
     - Нормализация: проверить обязательные поля `success`, `requestId`, при `success=true` — `asset`, `variations[]`.
  4) `types/index.ts`
     - Переэкспорт сгенерённых типов, утилиты/guards при необходимости.
  5) `index.ts`
     - Экспорт фасада:
       - `requestAssetById(assetId: string, context?: { tenantId?: string; userEmail?: string }): Promise<AMSAsset>` — один RPC вызов.
       - `selectVariation(asset: AMSAsset, options: { kind: 'image'|'video'; mode: 'preview'|'order'; scalingFactor?: number; preferProRes?: boolean }): AMSVariation | null` — чистая логика выбора.
       - `downloadVariationBuffer(url: string, timeoutMs?: number): Promise<Buffer>` — axios скачивание.

Примечание: Любая низкоуровневая AMQP‑логика (если нужна обёртка) располагается ВНУТРИ gateway, внешнему коду не экспортируется.

---

## Конфигурация
- `config/default.json` / `src/server/types/Config.ts` / `src/server/configuration/environment.ts`:
  - `ams.enabled: boolean`
  - `ams.requestQueue: string`
  - `ams.responseExchange?: string | null` (опционально; если указан — используем «Вариант B» с exchange)
  - `ams.timeout: number` (мс)
  - `ams.fallbackEnabled: boolean`
  - `ams.preferProResForOrders: boolean`
  - `ams.mp4FallbackForOrders: boolean`

---

## Интеграция в сервер (явно и однозначно)
- Удалить/депрекейтнуть прямое использование `src/server/services/ams/rabbitMQClient.ts` вне gateway.
- НЕ создавать отдельный listener/daemon — gateway сам создаёт временную очередь на время запроса и сам её чистит.
- Использование в ресурсном слое строго через gateway:
  - `src/server/services/resources/storage.ts`:
    - `getAMSResource(...)` → вызывает `gateway/ams`:
      1) `requestAssetById(assetId, context)`
      2) `selectVariation(asset, { kind, mode:'preview'|'order', scalingFactor, preferProRes: config.get().ams.preferProResForOrders })`
      3) `downloadVariationBuffer(url)` и возврат `Buffer`/`RuntimeValue`.
    - Методы `getRaw({ ams })`, `url({ ams })`, `mapToURLs({ ams })` — также через gateway (`selectVariation` → URL → дальше по назначению).
  - Контекст запроса (tenant/user): берём из `OperationServices.requestContext` (если добавлен); если его нет в текущем рантайме — отправляем без контекста.

ЯВНЫЙ ЗАПРЕТ: `ResourceStorage` не импортирует `amqplib`, `mq/connection`, `publish`, `declare` и т.п.; не создаёт очередей, не слушает их, не знает про AMQP.

---

## Выбор вариаций (строгие правила)
- image (preview/order):
  - Если у вариаций есть `height` — выбирать ближайшую к `round(1080 * (scalingFactor||1))`.
  - Если `height` отсутствует — брать первую `image/*`.
- video (preview по умолчанию):
  - MP4 вариации (`mimeType` содержит `video/mp4` или `container==='mp4'`) — выбрать ближайшую по `height` (или максимальную, если `height` нет).
- video (order, будущий тикет):
  - Если включён `preferProResForOrders` — сначала пытаться ProRes (`mimeType` содержит `video/quicktime` или `container==='prores'`), иначе fallback на MP4, иначе ошибка «нет подходящей вариации».

---

## Формат сообщений (пример)
- Запрос:
```json
{
  "type": "searchAssets",
  "requestId": "<uuid>",
  "replyTo": { "queue": "<exclusive.queue.name>" },
  "payload": { "offset": 0, "limit": 1, "query": { "field": "id", "operator": "equals", "value": "<assetId>" } },
  "context": { "tenantId": "optional", "userEmail": "optional" }
}
```
- Ответ (успех):
```json
{
  "requestId": "<uuid>",
  "success": true,
  "asset": {
    "id": "<assetId>",
    "type": "image|video",
    "variations": [ { "type": "video", "url": "https://...", "mimeType": "video/mp4", "height": 1080, "container": "mp4" } ],
    "metadata": {}
  }
}
```

---

## Логирование
- Использовать `src/server/services/logger.ts` (winston + OTEL):
  - Отправка: `logger.log('info','AMS request', { requestId, assetId, replyTo })`
  - Ответ/ошибки/таймаут: `logger.log('info'|'warn'|'error', ...)`

---

## Тесты
1) Unit: `gateway/ams/response/resultWaiter.ts` — очередь, consume, корреляция `requestId`, таймаут, очистка ресурсов; оба режима (A queue / B exchange) через конфиг.
2) Unit: `gateway/ams/response/parseResultMessage.ts` — валидные/битые ответы, пустые вариации.
3) Unit: `gateway/ams/index.ts` — happy‑path: запрос → выбор вариации → скачивание.
4) Unit: `ResourceStorage` (AMS ветки): image/video, ошибки/фолбэки.
5) Интеграционный мок MQ: фейковый consumer на `ams.request`, возврат ответа в указанную reply очередь; проверка end‑to‑end.

---

## Пошаговый чек‑лист выполнения
1) Создать YAML‑схемы в `documentation/api/schemas/remote/ams/{request.yaml,response.yaml}`.
2) Запустить `npm run build-json-schema-types` (проверить что типы появились в `src/jsonSchemas/remote/ams/*`).
3) Создать `src/server/gateways/ams/*` (вся структура из раздела «Структура gateway/ams»).
4) Перенести AMQP‑логику из `services/ams/rabbitMQClient.ts` ВНУТРЬ gateway и прекратить внешние импорты клиента.
5) Обновить `ResourceStorage` — вызовы только через `gateway/ams`.
6) Обновить конфиги/типы для `ams.responseExchange?` и чтение в `environment.ts`.
7) Написать юниты и мок‑интеграцию MQ; починить по результатам.
8) Смоук на стейдже: проверить режим A (queue). Если Freya требует exchange — включить `responseExchange` и перепроверить B.

---

## Критерии приёмки
- В коде присутствует `src/server/gateways/ams/` со всеми файлами; ResourceStorage не использует AMQP напрямую.
- Запрос к AMS идёт через per‑request очередь; после ответа очередь удаляется; таймаут очищает ресурсы.
- Выбор вариаций соответствует правилам; скачивание через axios; ошибки/фолбэки обработаны.
- Схемы существуют, типы сгенерированы, валидация включена.

---

## Приложение A: Быстрые запреты для ревьюера
- Нет импортов `amqplib`/`mq/*` в `ResourceStorage`.
- Нет глобального consumer на «общую очередь ответов AMS».
- `AMSRabbitMQClient` не используется вне `gateway/ams` (лучше удалён).
- Везде логирование через `logger`.


