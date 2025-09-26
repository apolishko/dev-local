# AMS интеграция: выявленные проблемы и ограничения

## Проблема #1: Неполная поддержка AMS в ResourceStorage

### Описание
Поддержка AMS в ResourceStorage ограничена только методом `get()`. Остальные методы выбрасывают исключения, что делает невозможным использование AMS ресурсов в ряде сценариев.

### Места в коде
**Файл:** `src/server/services/resources/storage.ts`

**Методы с ограничениями:**
- **getRaw()** (строка 169-171):
  ```typescript
  if (isValidAMSResourceReference(resourceReference)) {
    throw new Error('AMS raw resource handling not implemented yet');
  }
  ```

- **mapToURLs()** (строка 195-197):
  ```typescript
  if (isValidAMSResourceReference(resourceReference)) {
    throw new Error('AMS URL mapping not implemented yet');
  }
  ```

- **url()** (строка 211-213):
  ```typescript
  if (isValidAMSResourceReference(resourceReference)) {
    throw new Error('AMS URL generation not implemented yet');
  }
  ```

- **tryAMSFallback()** (строка 157-160):
  ```typescript
  async function tryAMSFallback(assetId: string): Promise<RuntimeValue | null> {
    logger.log('info', `AMS fallback attempted for: ${assetId}`);
    return null; // Заглушка
  }
  ```

### Работает только:
- **get()** (строки 61-86) - полностью реализован для Load Resource операции

### Последствия
Любой код, пытающийся:
- Получить raw буфер AMS ресурса → **💥 исключение**
- Получить прямые URL AMS ресурсов → **💥 исключение**
- Сгенерировать URL для AMS ресурса → **💥 исключение**

### Решение
Расширить реализацию этих методов или четко документировать ограничения AMS интеграции.

---

## Проблема #2: Браузерная операция loadResource не поддерживает AMS

### Описание
Браузерная версия операции `loadResource` не формирует корректные AMS ссылки. Независимо от значения третьего аргумента `source`, всегда формируется ссылка в формате generator (`{ resourceRef: ref }`).

### Места в коде
**Файл:** `src/graphics/browser/operations/loadResource.ts`

**Проблемные места:**
- **loadResource()** (строки 40-44):
  ```typescript
  const resource = await services.resourceStorage.get(
    { resourceRef: ref },  // ← Всегда generator формат!
    { type: resourceType } as InteroperationType,
    config.scalingFactor
  );
  ```

- **getAssetURLsImplementation()** (строка 60):
  ```typescript
  return [{ resourceRef: ref, type: { type: InteroperationTypeNames[resourceType] } }];
  // ← Всегда generator формат!
  ```

### Сравнение с серверной версией
**Серверная версия работает корректно** (`src/graphics/server/operations/loadResource.ts`, строки 286-287):
```typescript
const resourceReference: ResourceReference =
  source === 'generator' ? { resourceRef: ref } : { ams: ref };
```

### Последствия
- Браузер всегда пытается загрузить как generator ресурс
- AMS ресурсы недоступны в клиентской части
- Нарушена симметрия между server/browser операциями

### ✅ Решение (ИСПРАВЛЕНО)
Добавлена в браузерную версию логика выбора формата ссылки:

**Файл:** `src/graphics/browser/operations/loadResource.ts` (строки 41-43)
```typescript
const resourceReference = source === 'generator'
  ? { resourceRef: ref }
  : { ams: ref };
```

**Особенности реализации:**
- **loadResource()** - корректно формирует ResourceReference для AMS
- **getAssetURLsImplementation()** - возвращает пустой массив для AMS ресурсов (требует доработки AssetPreloader)
- **Типизация** - проходит без ошибок
- **Симметрия** - восстановлена между server/browser версиями

**Ограничения:**
- AssetPreloader в браузере пока не поддерживает AMS preloading
- Требуется дальнейшая доработка браузерного ResourceStorage

---

## Проблема #3: Флаги конфигурации заказов не задействованы

### Описание
Конфигурационные флаги `preferProResForOrders` и `mp4FallbackForOrders` считываются из конфига, но не влияют на pipeline заказов, так как ResourceStorage всегда использует режим `'preview'`.

### Места в коде

**Конфигурация корректна:**
- `config/default.json` (строки 151-152)
- `config/test.json` (строки 70-71)
- `src/server/types/Config.ts` (строки 152-153)
- `src/server/configuration/environment.ts` (строки 208-209)

**Проблема в использовании:**
**Файл:** `src/server/services/resources/storage.ts` (строки 136-140)
```typescript
const variation = amsGateway.selectVariation(asset, {
  mode: 'preview',                                    // ← Хардкод!
  scalingFactor,
  preferProRes: config.get().ams.preferProResForOrders,  // ← Читается но не влияет
});
```

**Логика существует но не работает:**
**Файл:** `src/server/gateways/ams/index.ts` (строки 112-121)
```typescript
// ProRes логика работает ТОЛЬКО если mode === 'order'
if (mode === 'order' && preferProRes) {
  // Пытается найти ProRes вариации
}
// Но mode всегда 'preview'!
```

**Неиспользуемый флаг:**
- `mp4FallbackForOrders` вообще не задействован в коде

### Последствия
- `preferProResForOrders` игнорируется - потому что `mode !== 'order'`
- `mp4FallbackForOrders` полностью не используется
- Заказы всегда получают preview-качество вместо высококачественного ProRes
- Нет различия между preview и order режимами

### Решение
1. **Определить контекст заказа** - добавить механизм передачи информации о том, что это заказ vs preview
2. **Протянуть режим через вызовы** - от операции Load Resource до ResourceStorage
3. **Использовать `mp4FallbackForOrders`** флаг в логике выбора вариаций
4. **Архитектурное решение** - как различать preview vs order контексты в системе

---

## Статус проблем

| Проблема | Критичность | Статус | Влияние на продакшен |
|----------|-------------|--------|---------------------|
| #1 - Неполная поддержка ResourceStorage | Средняя | Документирована | Ограничивает сценарии использования |
| #2 - Браузерная операция loadResource | Высокая | ✅ **ИСПРАВЛЕНО** | AMS теперь работает в браузере |
| #3 - Флаги заказов не работают | Высокая | Требует архитектурного решения | Заказы получают неправильное качество |

## Рекомендации

1. **Для немедленного релиза:** Четко документировать ограничения проблем #1 и #3
2. **Для полноценной поддержки:** Исправить проблему #2 как критическую
3. **Для production-ready:** Решить все три проблемы с архитектурным подходом

## Ключевые выводы:
1. Проблема #2 (браузер) - критическая, блокирует AMS в клиенте
2. Проблема #3 (заказы) - высокая, влияет на качество
3. Проблема #1 (ResourceStorage) - средняя, ограничивает функциональность



============================
ейчас у нас:
// Browser AssetPreloader currently only supports generator resources
// AMS resources will need to be handled differently in browser context
if (source === 'ams') {
// For now, return empty array for AMS resources in browser
// TODO: Implement proper AMS resource preloading in browser
return [];
}
Но как именно " Implement proper AMS resource preloading in browser"?
⎿  ⧉ Selected 7 lines from src/graphics/browser/operations/loadResource.ts in WebStorm

● Отличный вопрос! Давайте разберем, как именно можно реализовать proper AMS resource preloading в браузере.

Анализ текущей архитектуры

Сначала посмотрим, как работает AssetPreloader:

● Read(src/browser/types/OperationServices/AssetPreloader/index.ts)
⎿  Read 51 lines (ctrl+o to expand)

● Теперь посмотрим, как работает браузерный ResourceStorage:

● Search(pattern: "get.*ResourceReference", glob: "src/browser/**/*.ts")
⎿  Found 1 file (ctrl+o to expand)

● Read(src/browser/viewer/Viewer/resourceStorage.ts)
⎿  Read 170 lines (ctrl+o to expand)

● Отлично! Теперь я понимаю архитектуру. Давайте разберем, как можно реализовать proper AMS resource preloading:

Проблема с текущей архитектурой

AssetPreloader ожидает:
- ResourcePreloadRequest = { resourceRef: string; type: InteroperationType; scalingFactor?: number }

Но AMS ресурсы имеют:
- { ams: string } вместо { resourceRef: string }

Варианты решения

Вариант 1: Расширить типы AssetPreloader (рекомендуемый)

// Добавить новый тип для AMS preloading
export type AMSPreloadRequest = {
ams: string;
type: InteroperationType;
scalingFactor?: number
};

export type AssetPreloadRequest =
| URLPreloadRequest
| FontPreloadRequest
| RenderPreloadRequest
| ResourcePreloadRequest
| AMSPreloadRequest;  // ← Новый тип

export type PreloadedAMSResource = {
ams: string;
scalingFactor?: number;
data: HTMLCanvasElement | Blob
};

export type PreloadedAsset =
| PreloadedURL
| PreloadedRenderURL
| PreloadedFont
| PreloadedResource
| PreloadedAMSResource;  // ← Новый тип

Вариант 2: Использовать браузерный ResourceStorage напрямую

// В getAssetURLsImplementation
if (source === 'ams') {
// Создаем специальный request который браузерный ResourceStorage сможет обработать
return [{
type: 'ams-resource',  // Специальный маркер
ams: ref,
type: { type: InteroperationTypeNames[resourceType] },
scalingFactor: config.scalingFactor
}];
}

Вариант 3: URL-based подход (промежуточное решение)

Поскольку браузерный ResourceStorage уже имеет логику для AMS через getOptimizedImageUrl, можно:

function getAssetURLsImplementation(config: OperationImplementationConfig, args: AssetURLArg[]): AssetPreloadRequest[] {
if (args.length !== 3) return [];

    const [resourceType, ref, source] = args;
    if (typeof resourceType !== 'string' || typeof ref !== 'string' || typeof source !== 'string') return [];
    if (!isResourceTypeName(resourceType)) return [];
    if (source !== 'generator' && source !== 'ams') return [];

    if (source === 'ams') {
      // Для AMS ресурсов используем URL-based подход
      // Получаем URL от AMS и используем как URLPreloadRequest
      const amsUrl = `/api/ams/assets/${ref}/optimized?scale=${config.scalingFactor || 1}`;
      return [{
        url: amsUrl,
        type: { type: InteroperationTypeNames[resourceType] }
      }];
    }

    return [{ resourceRef: ref, type: { type: InteroperationTypeNames[resourceType] } }];
}

Рекомендуемый подход: Вариант 1

Плюсы:
- Чистое архитектурное решение
- Типобезопасность
- Поддержка caching
- Симметрия с ResourceStorage

Минусы:
- Требует изменения core типов AssetPreloader
- Больше работы по реализации

Реализация:

1. Расширить типы в src/browser/types/OperationServices/AssetPreloader/index.ts
2. Добавить логику обработки в AssetPreloader implementation
3. Обновить getAssetURLsImplementation в loadResource



===========
Для понимания текущей задачи: изначально был план @local/603-coding-docs/603-ams-inegration-plan-claude-ru-2.md, потом рефакторинг согласно @local/603-coding-docs/603-refactoring-plan-v2-ru.md.
В конечном итоге 603 был имплементирован так как ты можешь видеть из @local/603-done.diff. Были некоторые оступления от плана, как ты видишь. Поэтому имплементация - источник правды.






==============
Смысл флагов конфигурации

preferProResForOrders

Назначение: Для заказов (orders) предпочитать ProRes формат вместо MP4
Логика:
- ProRes = высокое качество, большой размер файла, профессиональный workflow
- MP4 = сжатое качество, меньший размер, web-friendly
- Для заказов клиенты готовы ждать дольше ради качества
- Для preview нужна скорость загрузки

mp4FallbackForOrders

Назначение: Если ProRes недоступен для заказа, использовать MP4 как fallback
Логика:
- Некоторые ассеты могут не иметь ProRes вариаций
- Лучше дать MP4, чем вообще ничего
- Позволяет graceful degradation
