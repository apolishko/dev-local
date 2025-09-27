## Задача 603: Серверная интеграция AMS (RabbitMQ) — Детальный план имплементации

### Цель
- Включить загрузку ресурсов из AMS (Asset Management System) при серверном выполнении графов, параллельно с существующими ресурсами «generator».
- Протянуть новый аргумент источника `source: 'generator' | 'ams'` через операцию `Load Resource` (компилятор → узлы → имплементации → хранилище).
- Подготовить базу для тикета про видео (ProRes vs MP4): корректный выбор вариаций AMS и декодирование без жёсткой привязки к MP4.

### Зачем (ценность)
- Позволяет использовать централизованные активы из AMS в серверных прогонах и заказах.
- Даёт фундамент для видеосценариев следующего тикета (ProRes для заказа, ближайший по разрешению MP4 для превью).
- Сохраняет текущее поведение браузера (AMS-оптимизация картинок по URL) и типобезопасность (schema-first).

### Объём (MVP для 603)
1) Добавить и протащить `source: 'generator' | 'ams'` через операцию `Load Resource`.
2) Обновить сервер/браузер имплементации `loadResource` на 3 аргумента и маршрутизацию по `source`.
3) Расширить платформенные типы/валидаторы для поддержки AMS-ссылок.
4) Реализовать ветку AMS в серверном ResourceStorage (сначала заготовка, затем клиент RabbitMQ).
5) Убрать жёсткую привязку к MP4 в `Select Frame From Video` для поддержки ProRes (MOV).
6) Ввести RabbitMQ-клиент AMS (request/response) и подцепить его в ветку AMS.

Вне объёма (позже при необходимости): загрузка видео AMS в браузере; расширенное кэширование; массовые сценарии.

---

## Целевое состояние архитектуры
- Значение параметра ресурса в SourceGraph — юнион `{ resourceRef: string } | { ams: string }` (уже есть в `types/SourceGraph/Resource.ts`).
- Компилятор инъектирует отдельный «Load Resource» узел на каждый ресурсный параметр, с аргументами `[resourceType, ref, source]`.
- Описание операции `Load Resource` обновлено до 3 аргументов.
- Имплементация на сервере выбирает ветку хранилища по `source`:
  - generator → существующий путь через blob-хранилище
  - ams → клиент RabbitMQ → AMS-воркер → ответ с URL → скачивание → возврат Buffer (image/binary)
- Извлечение кадров из видео не навязывает формат MP4; можно использовать контейнер из `services.videoData` или автоопределение ffmpeg.

---

## Изменения по файлам

### 1) Протягиваем `source` в описание операции и генерацию узла

- Файл: `src/platform/generic/data/operations/loadResource.ts`
  - Изменить количество аргументов с 2 до 3.
  - Новая сигнатура (описательно):
    - args: `['resource type': string, 'reference': string, 'source': 'generator' | 'ams']`
  - Outputs без изменений.

- Файл: `src/platform/generic/data/nodeClasses/processing/LoadResources/getLoadResourceNodeClass.ts`
  - Добавить параметр узла `source` (string) для каждого генерируемого Load … resource узла.
  - В `operationCall.args` добавить третий аргумент `{ source: 'parameter', name: 'source' }` после `resource type` и `ref`.
  - В итоге у узла есть параметры: `ref` (string), `source` (string); outputs — без изменений.

- Файл: `src/core/compiler/nodes/normalizeSourceGraphForCompiler/loadResourceParameterViaNode.ts`
  - Сейчас задаётся только `ref` из `parameter.value.resourceRef`.
  - Изменить логику:
    - Если `parameter.value` — `{ resourceRef }` → создать узел загрузки с `ref = resourceRef`, `source = 'generator'`.
    - Если `parameter.value` — `{ ams }` → создать узел загрузки с `ref = ams`, `source = 'ams'`.
  - Прокладка рёбер (edges) остаётся как есть.

### 2) Валидаторы и платформенные типы хранилища

- Файл: `src/platform/types/Services/ResourceStorage.ts`
  - Переопределить `ResourceReference` с единственного `{ resourceRef: string }` на юнион:
    - `type ResourceReference = { resourceRef: string } | { ams: string };`
  - Сигнатуры `GetResource` и `ResourceStorage` оставить с использованием `ResourceReference` как есть.

- Файл: `src/types/InteroperationTypes/ValuePredicates.ts`
  - Обновить `isValidResourceReference(value)`, чтобы возвращал `true` для обоих видов (`{ resourceRef }` и `{ ams }`).
  - Добавить явные гард-функции:
    - `isValidGeneratorResourceReference(value): value is { resourceRef: string }`.
    - `isValidAMSResourceReference(value): value is { ams: string }`.

### 3) Имплементации операции

- Файл: `src/graphics/server/operations/loadResource.ts`
  - Принимать 3 аргумента; валидировать типы и значение `source`.
  - Собирать `ResourceReference` из `source`:
    - `'generator'` → `{ resourceRef: ref }`
    - `'ams'` → `{ ams: ref }`
  - Вызывать `services.resourceStorage.get(resourceReference, { type: resourceType }, config.scalingFactor)`.
  - Сообщения об ошибках: включать `source` для ясности.

- Файл: `src/graphics/browser/operations/loadResource.ts`
  - Принимать 3 аргумента (пока игнорировать `source`). Браузерное хранилище `ViewerResourceStorage` уже умеет доставать URL и, при необходимости, запрашивать AMS-оптимизацию.
  - `getAssetURLsImplementation` оставляем как есть (generator-пути).

### 4) Серверное ResourceStorage: ветка AMS и правила для видео

- Файл: `src/server/services/resources/storage.ts`
  - Импортировать новые гард-функции из `types/InteroperationTypes/ValuePredicates`.
  - В `get(resourceReference, type, scalingFactor)`:
    - Проверять поддерживаемые типы — как раньше.
    - Если `isValidGeneratorResourceReference(resourceReference)` → существующая логика (blob) без изменений.
    - Если `isValidAMSResourceReference(resourceReference)`:
      - Для изображений: в MVP — звать заготовку `getAMSResourceViaRabbitMQ` (реализуем ниже). Если MQ ещё не подключен — возвращать `null` (под feature-флаг), а не бросать исключение.
      - Для бинарных данных/видео: выбирать вариацию AMS по правилам (см. ниже), скачивать и возвращать Buffer.
      - Для последовательностей изображений: пока не поддерживается → явная ошибка.
  - Добавить helper (сначала скелет, затем наполнение в шаге 6):
    - `async function getAMSResourceViaRabbitMQ(ref, type, scalingFactor): Promise<Buffer | null>` → publish → await → fetch file URL → нормализация (для image — `ensureImageProperties`) → Buffer.
  - Добавить хелперы выбора вариаций (для видео):
    - `selectProResOrFallbackMp4(assetMetadata): { url: string; mimeType: string }`
    - `selectClosestResolutionMp4(assetMetadata, scalingFactor?): { url: string; mimeType: string }`
    - Правила (связь со следующим тикетом):
      - Заказ (ProRes запрошен): взять ProRes MOV, при отсутствии — максимальный MP4.
      - Серверное превью: ближайший по высоте MP4 (по `scalingFactor` и/или `videoData`).
    - Использовать `services.videoData`, если задан (контейнер, fps, подсказки по разрешению); иначе — опираться на `scalingFactor`.

### 5) FFmpeg: убрать жёсткий MP4 в `Select Frame From Video`

- Файл: `src/graphics/server/operations/selectFrameFromVideo.ts`
  - Удалить принудительное `.inputFormat('mp4')` в `runFfmpeg`.
  - Опционально: брать контейнер из `services.videoData?.container` и вызывать `.inputFormat()` только при необходимости/знании. Если неизвестно — позволить ffmpeg автоопределение.
  - Фильтры/опции для извлечения кадра оставить без изменений.

### 6) RabbitMQ AMS клиент (сервер → AMS воркер)

- Новый файл: `src/server/services/ams/rabbitMQClient.ts`
  - Назначение: публиковать запросы в `ams.request`, получать ответы из `ams.response.server`, маппить по `correlationId`/`requestId`, поддерживать таймаут.
  - Пример API:
    - `requestImageResource({ assetId, parameters: { scale|height }, resourceType, requestId }): Promise<{ success: boolean; fileUrl?: string; error?: string }>`
    - `requestBinaryResource({ assetId, desired: { container?: 'mp4'|'mov', height?: number }, requestId }): Promise<...>`
  - Использовать существующие утилиты для подключения к RabbitMQ (по образцу ComfyUI/Omniverse).

- Новый файл: `src/server/mq/queues/ams.ts`
  - Экспорт имён очередей: `REQUEST = 'ams.request'`, `RESPONSE = 'ams.response.server'`, `STATUS = 'ams.status'`.

- Новый файл: `src/server/mq/listeners/ams.ts`
  - Лёгкий listener для ответов: хранит `requestId` → callback/promise resolution.
  - Используется внутри `rabbitMQClient.ts` или `storage.ts` для ожидания ответа.

### 7) Конфигурация

- Файл: `src/server/configuration/environment.ts`
  - Добавить секцию `ams`:
    - `enabled: boolean`
    - `requestQueue: string`
    - `responseQueue: string`
    - `timeout: number`
    - `fallbackEnabled: boolean`
  - Протянуть в значения из `config/*.json`.

- Файл: `config/default.json`
  - Добавить дефолты `ams` (безопасные значения), например:
    - `"ams": { "enabled": "false", "requestQueue": "ams.request", "responseQueue": "ams.response.server", "timeout": "30000", "fallbackEnabled": "true" }`

- Файл: `docker-compose.yml`
  - Опционально добавить env-переменные для `server`: `AMS_ENABLED`, `AMS_REQUEST_QUEUE`, `AMS_RESPONSE_QUEUE`, `AMS_TIMEOUT_MS`, `AMS_FALLBACK_ENABLED`.

### 8) Тесты

- Новые/обновлённые unit-тесты:
  - `src/graphics/server/operations/__tests__/loadResource.test.ts`
    - Обработка 3 аргументов; `'generator'` → `{ resourceRef }`; `'ams'` → AMS-ветка (MQ мокируется).
  - `src/server/services/resources/__tests__/storage.ams.test.ts`
    - Ветка AMS изображений (мок MQ → URL → fetch → buffer → ensureImageProperties), ветка AMS видео (вызов селекторов вариаций; буфер не пустой).
  - `src/graphics/server/operations/__tests__/selectFrameFromVideo.test.ts`
    - Без предположения MP4; убедиться, что ProRes/MOV декодируется (можно под охраной/моком ffmpeg).

- Интеграционные тесты (по возможности) — AMS «счастливый путь» через мок-ответ MQ.

### 9) Совместимость и миграция
- Обратная совместимость: графы с `{ resourceRef }` продолжают работать; новый аргумент `source` корректно выставляется компилятором.
- Браузерные сценарии без изменений; AMS-оптимизация изображений по URL остаётся.
- Если MQ не настроен (`ams.enabled=false`), AMS-ветка возвращает `null` и верхний уровень должен деградировать gracefully (или fallback по конфигу).

### 10) Критерии приёмки
- `Load Resource` принимает 3 аргумента на всех уровнях, билд проходит, графы исполняются.
- Сервер исполняет графы с AMS ресурсами (image/binary) при доступности очередей AMS:
  - Изображения: загружаются через MQ, возвращаются нормализованные PNG-буферы с альфой.
  - Видео: для заказа с ProRes → MOV если есть, иначе максимальный MP4; для серверного превью → ближайший MP4 по разрешению.
- `Select Frame From Video` работает с MP4 и ProRes/MOV буферами.
- Добавлены/обновлены тесты; проверка типов и тест-сьют зелёные.

### 11) План отката
- Откатить изменения сигнатур операции и генерации узла при необходимости.
- Файлы клиента RabbitMQ изолированы — их можно удалить без влияния на путь generator.

---

## Чеклист имплементации (по шагам)
1) Обновить описание операции и генерацию узла (добавить `source`).
2) Обновить валидаторы и типы платформы под юнион `ResourceReference`.
3) Обновить браузер/сервер `loadResource` на 3 аргумента.
4) В `storage.ts` развести маршрутизацию (generator vs AMS) и добавить заглушки.
5) Убрать `.inputFormat('mp4')` в `selectFrameFromVideo.ts`; использовать `videoData?.container`, если есть.
6) Реализовать RabbitMQ AMS клиент и подключить AMS-ветку в `storage.ts`.
7) Добавить тесты; добиться зелёного билда/тестов.

---

## Заметки по AMS-схемам и готовности к следующему тику
- Приложенные схемы AMS (image, video/mp4 и др.) предполагают стандартные вариации (например, 1080/720/480, `previewImage`). Хелперы выбора должны сопоставлять эти ID по разрешению и контейнеру.
- Данный план разблокирует следующий тикет:
  - ProRes (заказ): реализуется в селекторах вариаций AMS и декодируется ffmpeg после снятия `inputFormat('mp4')`.
  - Серверное превью (ближайший MP4): реализуется селектором вариаций по `scalingFactor` и/или `videoData`.
  - Браузерное превью (ближайший MP4): может быть отдельным улучшением (загрузка по URL) и не блокирует серверные фичи.

---

## Вопросы и ответы (чтобы не осталось неопределённостей)

1) Schema-first: где менять — YAML или TS?
- Контракты/схемы — через YAML в `documentation/api/schemas/` с генерацией типов (`npm run build-json-schema-types`).
- Платформенные внутренние типы/валидаторы (например, `platform/types/Services/ResourceStorage.ts`, `ValuePredicates.ts`) — ручные, правим напрямую.
- Для AMS ссылка уже описана в YAML (`amsResource`), так что дополнительных YAML-правок не требуется для 603.

2) Генерация гардов — из схем или руками?
- У нас гарды не генерятся. `ValuePredicates.ts` — ручной файл. Обновляем `isValidResourceReference` и добавляем `isValidAMSResourceReference`/`isValidGeneratorResourceReference` вручную.

3) Где в YAML описан ResourceReference?
- В `documentation/api/schemas/template/regularNode.yaml` есть тип `amsResource` (объект с полем `ams`).
- Юнион «`{ resourceRef } | { ams }`» — это модель данных графа/платформы. Нормализация компилятора распознаёт оба и проставляет `source`.

4) Сложность выбора видео (ProRes/MP4) — хардкодить или конфигурировать?
- Базовые правила — в коде (прозрачно и тестируемо), но ключи делаем конфигурируемыми:
  - `preferProResForOrders` (bool), `mp4FallbackForOrders` (bool), маппинг вариаций по высоте.
- Если нет ни ProRes, ни MP4 — бросаем осмысленную ошибку с контекстом (assetId, доступные вариации).

5) Что делать, если AMS недоступен?
- Если параметр — именно AMS (`{ ams }`) и альтернативы нет — ошибка (таймаут/код), опционально при `fallbackEnabled=true` пробуем «наименьшую боль» (например, `previewImage`), если определено в схеме.
- Если узел допускает оба источника (редко) — порядок: AMS → generator.
- Браузерная оптимизация изображений по URL — другая ветка, не ломаем.

6) Настройка RabbitMQ для AMS — уже есть или добавляем?
- Добавляем очереди `ams.request`, `ams.response.server`, `ams.status` по аналогии с ComfyUI/Omniverse. Они создаются на стадии декларации или воркером AMS.
- Аутентификация — стандартная `RABBITMQ_CONNECTION_STRING` из окружения. Доп. права — как в текущей инфраструктуре.

7) Кэширование — где?
- MVP: доверяем кэшу AMS/CDN.
- Дальше: кэш метаданных ответов AMS (Redis/LRU) и, при необходимости, кэш файлов/вариаций; также кэшируем «выбор вариации», чтобы не гонять MQ каждый раз.

8) Миграция старых графов — откуда возьмётся `source`?
- Автоматически. Нормализация при сборке графа создаёт `Load Resource`-узел и проставляет `source='generator'` для `{ resourceRef }` и `source='ams'` для `{ ams }`.

9) Интеграционные проверки AMS на стейдже/проде?
- Контрактные тесты по Swagger AMS.
- E2E смоук с реальными `assetId` (белый список) + метрики (время/таймауты) + healthcheck очередей.
- Фича-флаг `ams.enabled` для постепенного включения.

10) Перфоманс — MQ + скачивание не бесплатно. Требования?
- Таймауты и ретраи в MQ-клиенте, батч/предзагрузка частых активов, кэш метаданных, CDN.
- Мерим p95: изображения ~300–500 мс (при прогретом CDN); видео — зависит от размера; извлечение кадров уже выполняется на выделенном `svfsScheduler`.
- При деградации — включаем кэш уровнем выше/ниже.


