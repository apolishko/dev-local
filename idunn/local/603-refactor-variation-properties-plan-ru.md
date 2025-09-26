# Рефакторинг AMS Response Variation: добавление properties объекта

## Цель рефакторинга

Перенести поле `height` из корневого уровня AMS Response Variation в новый объект `properties` и добавить множество дополнительных полей для детального описания медиа-характеристик файлов.

## Анализ текущего состояния

### Текущая схема (response.yaml):
```yaml
amsResponseVariation:
  title: AMS response Variation
  type: object
  additionalProperties: false
  required: [url, height, mimeType]
  properties:
    url:
      type: string
      format: uri
    height:
      type: integer
      minimum: 1
    mimeType:
      type: string
```

### Места использования `height`:
1. **`src/server/gateways/ams/index.ts`**:
   - Строка 102: `getMasterHeight()` - `Math.max(...variations.map(v => v.height))`
   - Строка 149: `selectBestVariationByHeight()` - `Math.abs(best.height - targetHeight)`
   - Строка 150: `selectBestVariationByHeight()` - `Math.abs(current.height - targetHeight)`

2. **`test/server/integration/ams.test.ts`**:
   - Строка 46: `expect(variation.height).toBeDefined()`

3. **`test/support/server/fakeRemotes/fakeAMS.ts`**:
   - Строка 135: `height: variation.height` в формировании mock ответа

## Новая структура

### Целевая схема:
```yaml
amsResponseVariationProperties:
  title: AMS response Variation Properties
  type: object
  additionalProperties: false
  properties:
    # Базовые размеры
    width:
      type: integer
      minimum: 1
      description: 'Image width in pixels'
    height:
      type: integer
      minimum: 1
      description: 'Image height in pixels'

    # Цветовые характеристики
    colorDepth:
      type: integer
      minimum: 1
      description: 'Color depth in bits'
    aspectRatio:
      type: number
      minimum: 0
      description: 'Aspect ratio (width/height)'
    colorSpace:
      type: string
      description: 'Color space (sRGB, Adobe RGB, etc.)'
    hasAlpha:
      type: boolean
      description: 'Whether image has alpha/transparency channel'

    # Видео характеристики
    duration:
      type: number
      minimum: 0
      description: 'Duration in seconds'
    fps:
      type: number
      minimum: 0
      description: 'Frames per second'

    # Аудио характеристики
    sampleRate:
      type: integer
      minimum: 0
      description: 'Audio sample rate in Hz'
    channels:
      type: integer
      minimum: 0
      description: 'Number of audio channels'

    # Технические характеристики
    bitrate:
      type: integer
      minimum: 0
      description: 'Bitrate in bits per second'
    format:
      type: string
      description: 'File format name'
    codec:
      type: string
      description: 'Media codec name'
    sizeBytes:
      type: integer
      minimum: 0
      description: 'File size in bytes'
    mimeType:
      type: string
      description: 'MIME type of the file'

amsResponseVariation:
  title: AMS response Variation
  type: object
  additionalProperties: false
  required: [url, mimeType, properties]
  properties:
    url:
      type: string
      format: uri
    mimeType:
      type: string
    properties:
      $ref: '#/amsResponseVariationProperties'
```

## План реализации

### Шаг 1: Обновление YAML схемы

**Файл:** `documentation/api/schemas/remote/ams/response.yaml`

**Действия:**
1. Добавить новую схему `amsResponseVariationProperties` в конец файла (после строки 90)
2. Изменить схему `amsResponseVariation`:
   - Убрать `height` из `required` массива
   - Убрать `height` из `properties`
   - Добавить `properties` в `required` массив
   - Добавить `properties` в `properties` с `$ref: '#/amsResponseVariationProperties'`

**Результат:** Новая схема с properties объектом

### Шаг 2: Генерация TypeScript типов

**Команда:** `npm run build-json-schema-types`

**Результат:** Обновленные типы в:
- `src/types/gateways/ams/response.ts`
- `src/types/gateways/ams/responseSuccess.ts`
- `src/jsonSchemas/gateways/ams/response.ts`

### Шаг 3: Обновление AMS Gateway кода

**Файл:** `src/server/gateways/ams/index.ts`

**Изменения:**

1. **Строка 102 - функция `getMasterHeight()`:**
   ```typescript
   // БЫЛО:
   return Math.max(...variations.map(v => v.height));

   // СТАНЕТ:
   return Math.max(...variations.map(v => v.properties.height));
   ```

2. **Строка 149 - функция `selectBestVariationByHeight()`:**
   ```typescript
   // БЫЛО:
   const bestDiff = Math.abs(best.height - targetHeight);

   // СТАНЕТ:
   const bestDiff = Math.abs(best.properties.height - targetHeight);
   ```

3. **Строка 150 - функция `selectBestVariationByHeight()`:**
   ```typescript
   // БЫЛО:
   const currentDiff = Math.abs(current.height - targetHeight);

   // СТАНЕТ:
   const currentDiff = Math.abs(current.properties.height - targetHeight);
   ```

### Шаг 4: Обновление тестов

#### 4.1 Интеграционные тесты

**Файл:** `test/server/integration/ams.test.ts`

**Изменения:**

1. **Строка 46 - проверка height:**
   ```typescript
   // БЫЛО:
   expect(variation.height).toBeDefined();

   // СТАНЕТ:
   expect(variation.properties.height).toBeDefined();
   ```

2. **Добавить новые тесты после строки 46:**
   ```typescript
   // Добавить тесты для properties объекта
   expect(variation.properties).toBeDefined();
   expect(typeof variation.properties.height).toBe('number');
   expect(variation.properties.height).toBeGreaterThan(0);

   // Тесты для опциональных полей (если они есть в mock данных)
   if (variation.properties.width) {
     expect(typeof variation.properties.width).toBe('number');
     expect(variation.properties.width).toBeGreaterThan(0);
   }

   if (variation.properties.mimeType) {
     expect(typeof variation.properties.mimeType).toBe('string');
   }
   ```

#### 4.2 Fake AMS сервис

**Файл:** `test/support/server/fakeRemotes/fakeAMS.ts`

**Изменения:**

1. **Строки 133-137 - формирование вариаций:**
   ```typescript
   // БЫЛО:
   variations: assetData.variations.map(variation => ({
     url: variation.url,
     height: variation.height,
     mimeType: variation.mimeType
   }))

   // СТАНЕТ:
   variations: assetData.variations.map(variation => ({
     url: variation.url,
     mimeType: variation.mimeType,
     properties: {
       height: variation.height,
       width: variation.width || Math.round(variation.height * 1.5), // Mock width если нет
       mimeType: variation.mimeType, // Дублируем mimeType в properties
       sizeBytes: variation.sizeBytes || 1024000, // Mock размер файла
       // Добавляем другие mock поля по необходимости
       ...(variation.duration && { duration: variation.duration }),
       ...(variation.fps && { fps: variation.fps })
     }
   }))
   ```

### Шаг 5: Обновление тестовых fixture данных

**Предположительные файлы с тестовыми данными (нужно найти и обновить):**

Поиск файлов с mock AMS данными:
```bash
find test/ -name "*.ts" -o -name "*.json" | xargs grep -l "height.*variation\|variation.*height"
```

Если есть статические fixture файлы с данными вариаций, их нужно обновить в соответствии с новой схемой.

### Шаг 6: Проверка и валидация

**Команды для запуска:**

1. **Проверка типов:**
   ```bash
   npm run build
   ```

2. **Запуск тестов:**
   ```bash
   npm run test-ams-integration
   ```

3. **Полная проверка:**
   ```bash
   npm run build && npm run test-server
   ```

## Ожидаемые результаты

### Структура данных после изменений:

```typescript
// Новый тип AMSVariation
interface AMSResponseVariation {
  url: string;
  mimeType: string;
  properties: {
    height: number;
    width?: number;
    colorDepth?: number;
    aspectRatio?: number;
    colorSpace?: string;
    hasAlpha?: boolean;
    duration?: number;
    fps?: number;
    sampleRate?: number;
    channels?: number;
    bitrate?: number;
    format?: string;
    codec?: string;
    sizeBytes?: number;
    mimeType?: string;
  };
}
```

### Пример данных:

```json
{
  "url": "https://example.com/image.jpg",
  "mimeType": "image/jpeg",
  "properties": {
    "height": 1080,
    "width": 1920,
    "colorDepth": 24,
    "aspectRatio": 1.777,
    "colorSpace": "sRGB",
    "hasAlpha": false,
    "sizeBytes": 245760,
    "mimeType": "image/jpeg"
  }
}
```

## Критерии готовности

- ✅ YAML схема обновлена с новой структурой properties
- ✅ TypeScript типы сгенерированы без ошибок
- ✅ AMS Gateway код обновлен для использования `properties.height`
- ✅ Все тесты проходят успешно
- ✅ Mock данные в fake AMS содержат properties объект
- ✅ Интеграционные тесты проверяют новую структуру данных
- ✅ Сборка проекта проходит без ошибок типизации

## Дополнительные соображения

### Backwards compatibility
Не требуется - фича новая, внешних потребителей нет.

### mimeType на двух уровнях
Это нормально - на верхнем уровне для быстрого доступа, в properties для детальной информации.

### Валидация
`height` остается обязательным полем, но теперь внутри `properties` объекта. Все остальные поля в `properties` опциональные.

### Расширяемость
Структура `properties` позволяет легко добавлять новые характеристики медиа-файлов в будущем без изменения корневой схемы.