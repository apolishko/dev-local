## 603: План замены заглушек AMS и переход на per‑request очереди (RabbitMQ)

### Цель
- Заменить заглушки в серверном `ResourceStorage` на реальную интеграцию с AMS через RabbitMQ.
- Перейти с одной общей очереди ответов на per‑request exclusive reply queue (классический RPC‑паттерн) c корреляцией по `requestId`.
- Поддержать загрузку изображений/видео из AMS и подготовить основу для ProRes/MP4 логики следующего тикета.

### Зачем
- Серверные прогоны и заказы должны уметь тянуть ассеты из AMS, а не только из blob‑хранилища генератора.
- Per‑request очередь убирает гонки и мешанину ответов, упрощает таймауты/очистку и снижает риск залипания слушателя.

### Текущее состояние (последний коммит черновой интеграции)
- Операция `Load Resource` расширена до 3 аргументов: `[resourceType, ref, source]` и роутит `generator|ams`.
- В `ResourceStorage` добавлены заглушки `getAMSResource`, `getAMSResourceViaRabbitMQ`, `tryAMSFallback`, а также валидация AMS/генераторных ссылок.
- Убран `inputFormat('mp4')` в `selectFrameFromVideo` — теперь декодер не прибит к MP4.
- Добавлен `ams`‑раздел в конфиг (фича‑флаги, очереди, таймауты) — но ответы пока через одну `responseQueue`.
- Черновой `AMSRabbitMQClient` использует фиксированную `responseQueue` и AMQP `replyTo` — заменим на per‑request exclusive очередь и `requestId` в payload.

---

## Требуемое поведение и протокол

### Общие правила
- Все запросы — в фиксированную очередь AMS `ams.request` (конфигурируемо).
- Ответы — в уникальную, на каждый запрос, эксклюзивную, авто‑удаляемую очередь.
- Корреляция — по `requestId` (UUID) в JSON‑сообщении.
- Таймаут обработки — из конфига `ams.timeout` (мс); по таймауту промис отклоняется и временная очередь удаляется.

### Формат сообщений (payload)
- Запрос (минимум):
```json
{
  "type": "searchAssets",
  "requestId": "<uuid>",
  "replyTo": {
    "queue": "<server.generated.exclusive.queue.name>"
  },
  "payload": {
    "offset": 0,
    "limit": 1,
    "query": { "field": "id", "operator": "equals", "value": "<assetId>" }
  },
  "context": {
    "tenantId": "<optional>",
    "userEmail": "<optional>"
  }
}
```
- Ответ (минимум):
```json
{
  "requestId": "<uuid>",
  "success": true,
  "asset": {
    "id": "<assetId>",
    "type": "image|video",
    "variations": [
      { "type": "image|video", "url": "https://...", "mimeType": "image/png|video/mp4|video/quicktime", "height": 1080, "container": "mp4|mov|prores" }
    ],
    "metadata": { }
  },
  "error": null
}
```

Примечание: точные поля берём из Freya; если AMS публикует ответы через exchange+routingKey, делаем биндинг нашей временной очереди к exchange нужным ключом (см. «Вариант B» ниже). По умолчанию реализуем «Вариант A» (replyTo.queue).

---

## Архитектурное решение per‑request reply queue

### Вариант A (базовый, рекомендуемый)
1) Для каждого запроса:
   - `channel.assertQueue('', { exclusive: true, autoDelete: true, durable: false })` → получаем сгенерированное имя.
   - Начинаем `consume` этой очереди; при первом валидном ответе (совпал `requestId`) — `cancel` consumer, `deleteQueue`.
   - Публикуем `sendToQueue(ams.request, JSON.stringify({...}))` c `replyTo.queue` в payload и `correlationId = requestId` в свойствах (опционально).
2) Таймаут: по истечении — снимаем consumer, удаляем очередь, отклоняем промис.

### Вариант B (если AMS отвечает через exchange)
1) Создаём `exclusive` очередь как в A.
2) `assertExchange('ams.response', 'direct', { durable: false })`.
3) `bindQueue(<exclusiveQueue>, 'ams.response', <randomRoutingKey>)`.
4) В запрос кладём `replyTo: { exchangeName: 'ams.response', routingKey: <randomRoutingKey> }` и слушаем свою очередь.

Мы закладываем поддержку обоих, но стартуем с А. Если Freya потребует B — переключим минимальными правками (см. ниже изменения клиента).

---

## Изменения по файлам (пошагово)

### 1) Конфигурация
- `config/default.json`
  - Добавить `responseExchange` (на будущее для Варианта B), оставить `responseQueue` для обратной совместимости, но по умолчанию клиент не будет им пользоваться.
  - Уточнить: `enabled`, `requestQueue`, `timeout`, `fallbackEnabled`, `preferProResForOrders`, `mp4FallbackForOrders` — актуальны.

- `src/server/types/Config.ts`
  - Добавить поле `ams.responseExchange?: string | null` (опционально).

- `src/server/configuration/environment.ts`
  - Читать `ams.responseExchange` как опциональное.

### 2) Gateway AMS (паттерн gateways)
- Путь: `src/server/gateways/ams/`
  - `request/requestHandler.ts` — валидация запроса (AJV по сгенерённой схеме), формирование payload (`type`, `requestId`, `replyTo`, `payload`, `context`), публикация в `ams.request` с per‑request exclusive reply queue, логирование.
  - `response/resultWaiter.ts` — создание и прослушивание per‑request очереди, корреляция по `requestId`, таймаут, завершение (cancel consumer + deleteQueue), возврат нормализованного результата.
  - `response/parseResultMessage.ts` — нормализация `asset`/`variations`, проверка обязательных полей, приведение типов (image/video, mime/container, height), сообщения об ошибках.
  - `types/` — обвязка над сгенерёнными типами схем (Request/Response), runtime‑guards при необходимости.
  - `index.ts` — экспорт `requestAsset`/`requestAssetMetadata` и вспомогательных типов.
  - Примечание: реализация RPC (assertQueue/consume/send/cleanup) может жить здесь (внутри gateway) или вызываться через низкоуровневый клиент; выбираем «внутри gateway», чтобы следовать паттерну других gateways.

### 3) Схемы AMS (schema-first)
- Путь: `documentation/api/schemas/remote/ams/`
  - `request.yaml` — поля: `type` (enum: [`searchAssets`]), `requestId` (string, uuid), `replyTo` (oneOf: `{ queue }` или `{ exchangeName, routingKey }`), `payload` (объект поиска по `id`), `context` (optional: `tenantId`, `userEmail`). `additionalProperties: false`.
  - `response.yaml` — поля: `requestId` (string), `success` (boolean), `asset` (object с `id`, `type`, `variations[]`, `metadata`), `error` (string|null). `additionalProperties: false`.
- Генерация типов: `npm run build-json-schema-types` → типы в `src/jsonSchemas/remote/ams/*` + экспорты.

### 4) MQ‑клиент для AMS
- `src/server/services/ams/rabbitMQClient.ts` — ПЕРЕРАБОТАТЬ:
  - Интерфейсы: `AMSResourceRequest`/`Response` оставить, но в `request` добавить поле `type: 'searchAssets'` и `replyTo.queue`.
  - `initialize()`: держит `channel` живым (без глобального consumer на общий ответ).
  - `requestAssetMetadata(assetId, options)`:
    - Генерирует `requestId`.
    - `assertQueue('', { exclusive: true, autoDelete: true, durable: false })` → `replyQueue`.
    - `consume(replyQueue, onMessage)`; в `onMessage` парсит JSON, сверяет `requestId`, резолвит/реджектит, затем `cancel` + `deleteQueue`.
    - `sendToQueue(requestQueue, Buffer(JSON))` — JSON содержит `requestId`, `type`, `payload`, `replyTo: { queue: replyQueue }` (+ `context`).
    - Таймер `setTimeout` по `config.timeout` с очисткой очереди/consumer.
  - Опционально: реализовать «Вариант B» через `responseExchange` (если задан в конфиге) — тогда создаём биндинг.

### 5) Интеграция в сервер
- `src/server/mq/listeners/ams.ts`
  - После создания соединения AMQP — инстанцировать `AMSRabbitMQClient` и вызвать `initialize()`.
  - Экспортировать готовый инстанс/фабрику, чтобы использовать в `ResourceStorage`.

### 6) ResourceStorage — замена заглушек
- `src/server/services/resources/storage.ts`
  - `getAMSResource`: вызывать `getAMSResourceViaRabbitMQ(assetId, resourceType, scalingFactor)`.
  - `getAMSResourceViaRabbitMQ` (реализация):
    1) Вызвать `amsClient.requestAssetMetadata({ assetId, resourceType, parameters: { scale: scalingFactor } })`.
    2) Проверить `success`/наличие `asset`.
    3) Выбрать вариацию:
       - Для `image`: ближайшая по высоте/масштабу; контейнер не критичен; `mimeType` → image/*.
       - Для `video` (серверная превью‑логика по умолчанию): ближайший по разрешению MP4 (`mimeType` содержит `video/mp4` или `container === 'mp4'`).
       - Для заказа (будущий тикет): если `preferProResForOrders` — сначала попытаться ProRes (`mimeType` содержит `video/quicktime` или `container === 'prores'`); при отсутствии — MP4, иначе ошибка.
    4) Скачать `url` выбранной вариации в `Buffer` (через `fetch`/`axios`/`undici` — выбрать общий для проекта способ).
    5) Вернуть `Buffer` (или подходящий `RuntimeValue` для изображений/видео).
  - `getRaw`/`url`/`mapToURLs` для `{ ams }`:
    - `getRaw({ ams })`: аналогочно — выбрать «оригинал»/лучшую вариацию и скачать в `Buffer`.
    - `url({ ams })` и `mapToURLs({ ams })`: вернуть прямой `url` выбранной вариации (без пресайна blob, это внешний URL AMS/CDN).
  - Ошибки/фолбэк:
    - Если AMS выключен и `fallbackEnabled=true` — возвращать `null` (или, если бизнес‑требование появится, пытаться маппить `assetId` на generator, но сейчас данных нет — считаем `null`).

### 7) Выбор вариаций (чёткие правила)
- `image`:
  - Если есть `height` — берем ближайшую к `round(1080 * scalingFactor)` (или к `config.defaultImageHeight`, если понадобится).
  - Если `height` нет — берём первую подходящую `image/*`.
- `video` (сервер‑превью по умолчанию):
  - Все MP4 вариации → выбрать ближайшую по `height` к `round(1080 * scalingFactor)`; если нет `height` — берём максимальную.
  - Для заказа (в будущем): если включён флаг ProRes — попытаться ProRes; при отсутствии — MP4; иначе ошибка «нет подходящей вариации».

### 8) Безопасность/контекст
- Включить в payload `context.tenantId`/`context.userEmail`, если доступны из текущего рунтайм‑контекста (пока опционально).

---

## Тесты
- Unit: `AMSRabbitMQClient`
  - Создание exclusive очереди, публикация запроса, получение ответа, таймаут, очистка (cancel/deleteQueue), поддержка обоих вариантов A/B (через заглушку обменника).
- Unit: `ResourceStorage` AMS
  - Успешные сценарии: image/video, выбор вариации по высоте/контейнеру, скачивание URL.
  - Ошибки: `success=false`, пустые вариации, нет подходящего контейнера, таймаут AMS, AMS disabled + fallback.
- Интеграционный мок MQ: фейковый consumer на `ams.request`, ответ в указанную reply очередь; проверка цепочки end‑to‑end.

---

## Миграция/совместимость
- Графы с 2 аргументами уже не компилируются — но генерация ноды `Load Resource` теперь всегда добавляет `source`, а компилятор пробрасывает его (по умолчанию `generator`). Обратная совместимость сохранена.
- Конфиг: добавляем `responseExchange` (необязателен); `responseQueue` оставляем для отладки/совместимости, но клиент по умолчанию работает через per‑request очередь.

---

## Пошаговый чек‑лист реализации
1) Обновить конфиг/типы: `responseExchange?` (опционально), чтение в `environment`.
2) Переписать `AMSRabbitMQClient` под per‑request exclusive очередь (+ поддержка exchange‑варианта через конфиг).
3) Инициализировать клиент на старте (listeners/ams.ts) и прокинуть в `ResourceStorage`.
4) Реализовать `getAMSResourceViaRabbitMQ` (payload, выбор вариации, скачивание, ошибки/таймауты).
5) Реализовать `getRaw`/`url`/`mapToURLs` для `{ ams }` через `variations`.
6) Написать unit‑тесты на клиент и хранилище; мок MQ для интеграции.
7) Док‑апдейт: README/конфиги по AMS.

---

## Риски и смягчение
- Несогласованность протокола с Freya: заложили оба способа ответа (A/B). Проверить на стейдже и зафиксировать один.
- Таймауты/залипание: обязательная очистка per‑request очередей + configurable timeout.
- Производительность: batch‑запросы не планируются; кеш на уровне ResourceStorage добавить позже (LRU по assetId+type+scale).

---

## Итог
После выполнения шагов заглушки исчезают, сервер умеет тянуть ассеты из AMS по RabbitMQ с корректной корреляцией и без общей очереди ответов. Логика выбора вариаций покрывает текущие потребности и готова к расширению для ProRes.

---

## Приложение 1: Технические уточнения

### Q1: HTTP-клиент для скачивания файлов
**Вопрос**: Какой HTTP-клиент использовать для скачивания файлов по URL из AMS variations?

**Ответ**: Использовать **axios** (уже в зависимостях). На сервере есть `src/server/utils/httpClient.ts` с `sendHTTP` (помечен deprecated, рекомендует axios). Серверный код ещё почти не использует axios, но это правильный выбор для HTTP-скачивания.

**Конфигурация**: `responseType: 'arraybuffer'`, разумный таймаут (например, 30 сек).

### Q2: Расположение схем AMS
**Вопрос**: Где создавать YAML-схемы для AMS запросов/ответов?

**Ответ**: Создать директорию `documentation/api/schemas/remote/ams/` с файлами `{request.yaml, response.yaml}`. Это консистентно с существующими remote-схемами (`remote/comfyUI*`, `remote/rtxRender`). Вариант `ams/intercommunication/` из плана менее логичен по структуре проекта.

### Q3: Контекст tenant/user в запросах
**Вопрос**: Откуда брать `tenantId`/`userEmail` для AMS payload?

**Ответ**: **Вариант Б** (правильный): расширить `OperationServices` полем `requestContext: { tenantId?, userEmail? }`, заполнять при создании ран-а из HTTP-заголовков (`x-tenant-id`, `x-user-email`). Прокидывать контекст из места старта операции в HTTP-слое.

Альтернатива (быстрая): протолкнуть контекст параметром в вызов gateway из `ResourceStorage`.

### Q4: RabbitMQ connection
**Вопрос**: Как подключиться к RabbitMQ для AMS-клиента?

**Ответ**: Использовать существующую инфраструктуру из `src/server/mq/connection.ts`. Есть `getDefaultChannel()` — использовать этот канал для per-request exclusive reply queue. НЕ создавать отдельное подключение, следовать паттерну существующих MQ-обработчиков.

### Q5: Логирование в проекте
**Вопрос**: Какой логгер использовать для AMS операций?

**Ответ**: **Winston** из `src/server/services/logger.ts` с OpenTelemetry транспортом. Методы: `logger.log(level, msg, meta)` и `logger.logError(err, meta)`. Никаких `console.*` — только централизованный логгер.

### Дополнительные детали:

- **Схемы**: После создания YAML запускать `npm run build-json-schema-types` для генерации TypeScript типов
- **Таймауты**: AMS запросы — из `config.ams.timeout`, HTTP скачивание — ~30 сек
- **Очистка ресурсов**: Обязательная очистка per-request очередей при таймауте/ошибке (`cancel` consumer + `deleteQueue`)
- **Fallback**: При `ams.enabled=false` и `fallbackEnabled=true` возвращать `null` (данных для маппинга на generator нет)


