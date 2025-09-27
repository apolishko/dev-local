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

### Решение
Добавить в браузерную версию логику выбора формата ссылки:
```typescript
const resourceReference = source === 'generator'
  ? { resourceRef: ref }
  : { ams: ref };
```

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

### 📋 Объяснение: Почему флаги не используются (намеренно)

**Это не баг, а задел для будущего тикета!**

Согласно документации `/local/603-coding-docs/603-for-ProRes.md`, в тикете 603 мы сознательно заложили **фундамент для ProRes поддержки**, но полная реализация запланирована на следующий тикет:

**Запланированная архитектура:**
- **"ProRes" requested for order** → должен получать ProRes из AMS (mode: 'order')
- **Server-side preview** → closest resolution MP4 (mode: 'preview')
- **Browser** → closest resolution MP4 (mode: 'preview')

**Где будет реализовано:**
- **Select Frame From Video** + **VideoData/VideoMacro** → определение контекста заказа
- **Передача через цепочку:** VideoMacro → Load Resource → ResourceStorage → AMS Gateway

**Текущее состояние (намеренно):**
- Флаги `preferProResForOrders` и `mp4FallbackForOrders` готовы в конфиге ✅
- Логика обработки режимов в AMS Gateway готова ✅
- ResourceStorage всегда использует `mode: 'preview'` как временное решение ⏳
- `mp4FallbackForOrders` пока не задействован (ждет контекста заказа) ⏳

### Решение (для будущего тикета)
1. **VideoData/VideoMacro** - добавить передачу контекста заказа
2. **Load Resource** - принимать режим из VideoMacro
3. **ResourceStorage** - получать режим от Load Resource
4. **Активировать `mp4FallbackForOrders`** в логике выбора вариаций

**Статус:** Архитектура готова, ждет имплементации в ProRes тикете 🚀

---

## Статус проблем

| Проблема | Критичность | Статус | Влияние на продакшен |
|----------|-------------|--------|---------------------|
| #1 - Неполная поддержка ResourceStorage | Средняя | Документирована | Ограничивает сценарии использования |
| #2 - Браузерная операция loadResource | Высокая | 
| #3 - Флаги заказов не работают | Низкая | 📋 **НАМЕРЕННО** (задел для ProRes тикета) | Ждет реализации VideoMacro контекста |

## Рекомендации

1. **Для немедленного релиза:** Четко документировать ограничения проблем #1 и #3
2. **Для полноценной поддержки:** Исправить проблему #2 как критическую
3. **Для production-ready:** Решить все три проблемы с архитектурным подходом

## Ключевые выводы:
1. Проблема #2 (браузер) - критическая, блокирует AMS в клиенте
2. Проблема #3 (заказы) - высокая, влияет на качество
3. Проблема #1 (ResourceStorage) - средняя, ограничивает функциональность
