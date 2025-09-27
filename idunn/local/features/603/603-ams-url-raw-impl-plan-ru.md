# План реализации AMS URL/RAW поддержки

## Контекст и проблема

**Текущее состояние:**
- `src/server/services/resources/storage.ts:getRaw()` - бросает `Error('AMS raw resource handling not implemented yet')` (строка 170)
- `src/server/services/resources/storage.ts:mapToURLs()` - бросает `Error('AMS URL mapping not implemented yet')` (строка 196)
- `src/server/services/resources/storage.ts:url()` - бросает `Error('AMS URL generation not implemented yet')` (строка 212)

**Проблемы:**
- Любой код, ожидающий URL от AMS ресурсов, падает
- Нельзя получить сырые данные AMS файлов для экспорта/отладки
- Прелоадеры и внешние интеграции не работают с AMS

**Цель:**
Реализовать поддержку `getRaw()`, `mapToURLs()`, `url()` для AMS ресурсов через единый helper и blob storage кэширование.

## Архитектурное решение

### Принципы:
1. **Единая логика выбора вариации** - используем `selectVariation()` везде
2. **Детерминированный кэш** - одинаковые параметры → один файл в blob storage
3. **Переиспользование кода** - один helper для `get()`, `getRaw()`, `mapToURLs()`
4. **Безопасность** - все URL через наш blob storage, никаких прямых ссылок на Freya

### Ключи кэша:
```
Формат: ams/<assetId>/<mode>/<scalingFactor>/<variationKey>

Примеры:
- ams/image-001/preview/default/a1b2c3d4
- ams/video-002/preview/0.500/e5f6g7h8
- ams/image-003/order/1.000/i9j0k1l2

Правила:
- scalingFactor отсутствует → "default" (используем ?? вместо ||)
- scalingFactor присутствует → форматируем как X.XXX (toFixed(3))
- mode всегда нормализуется к 'preview'|'order' (используем ?? 'preview')
- variationKey - MD5 хеш от "mimeType-WxH-url" (первые 8 символов)
  ВАЖНО: variation.id НЕ СУЩЕСТВУЕТ в AMS схеме!
```

## Пошаговый план реализации

### 1. Создать helper функцию в AMS Gateway

**Файл:** `src/server/gateways/ams/index.ts`

**Добавить функцию:**
```typescript
/**
 * Fetch asset variation with caching to blob storage
 * Единая логика для get(), getRaw(), mapToURLs()
 */
export async function fetchAssetVariation(
  assetId: string,
  options: VariationSelectionOptions
): Promise<{
  asset: AMSAsset;
  variation: AMSVariation;
  buffer: Buffer;
  blobRef: string;
}> {
  // 1. Нормализуем параметры для кэш-ключа
  const normalizedOptions = {
    mode: options.mode ?? 'preview', // используем ?? для корректной обработки undefined
    scalingFactor: options.scalingFactor !== undefined ? options.scalingFactor.toFixed(3) : 'default', // корректная проверка для 0
    preferProRes: options.preferProRes ?? false,
  };

  // 2. Запрашиваем asset
  const asset = await requestAssetById(assetId);

  // 3. Выбираем вариацию (ЕДИНАЯ логика)
  const variation = selectVariation(asset, options);
  if (!variation) {
    throw new Error(`No suitable variation found for asset ${assetId}`);
  }

  // 4. Генерируем детерминированный ключ вариации (variation.id НЕ СУЩЕСТВУЕТ!)
  const variationKey = createHash('md5')
    .update(`${variation.mimeType}-${variation.properties.width || 0}x${variation.properties.height}-${variation.url}`)
    .digest('hex')
    .substring(0, 8);

  // 5. Формируем детерминированный ключ
  const blobRef = `ams/${assetId}/${normalizedOptions.mode}/${normalizedOptions.scalingFactor}/${variationKey}`;

  // 5. Проверяем кэш в blob storage
  const blobStorageClient = (await import('../../azure/blobStorageClient')).default;
  const cachedBuffer = await blobStorageClient.get(blobRef);

  if (cachedBuffer) {
    logger.log('info', 'AMS variation served from cache', { assetId, blobRef });
    return { asset, variation, buffer: cachedBuffer, blobRef };
  }

  // 6. Скачиваем и кэшируем
  logger.log('info', 'AMS variation downloading and caching', {
    assetId,
    variationUrl: variation.url,
    blobRef
  });

  const buffer = await downloadVariationBuffer(variation.url);

  // 7. Сохраняем в blob storage для кэширования
  await blobStorageClient.store(blobRef, buffer, variation.mimeType);

  return { asset, variation, buffer, blobRef };
}
```

**Добавить импорт:**
```typescript
import type { VariationSelectionOptions } from './types';
import { createHash } from 'node:crypto'; // для генерации variationKey
```

### 2. Обновить тип VariationSelectionOptions

**Файл:** `src/server/gateways/ams/types/index.ts`

**Убедиться что тип полный:**
```typescript
export type VariationSelectionOptions = {
  mode?: 'preview' | 'order';
  scalingFactor?: number;
  preferProRes?: boolean;
};
```

### 3. Рефакторить getAMSResourceViaRabbitMQ

**Файл:** `src/server/services/resources/storage.ts`

**Заменить функцию:**
```typescript
async function getAMSResourceViaRabbitMQ(
  assetId: string,
  scalingFactor?: number
): Promise<RuntimeValue | null> {
  const amsGateway = (await import('../../gateways/ams'));

  try {
    const { buffer } = await amsGateway.fetchAssetVariation(assetId, {
      mode: 'preview',
      scalingFactor,
      preferProRes: config.get().ams.preferProResForOrders,
    });

    // Для get() применяем ensureImageProperties
    return await ensureImageProperties(buffer);
  } catch (error) {
    throw new Error(`AMS asset ${assetId} failed: ${(error as Error).message}`);
  }
}
```

### 4. Реализовать getRaw для AMS

**Файл:** `src/server/services/resources/storage.ts`

**Заменить throw на реализацию:**
```typescript
async function getRaw(resourceReference: ResourceReference): Promise<Buffer | null> {
  if (isValidGeneratorResourceReference(resourceReference)) {
    const storedResource = await blobStorageClient.get(resourceReference.resourceRef);
    if (!storedResource) return null;
    return storedResource;
  }

  if (isValidAMSResourceReference(resourceReference)) {
    if (!config.get().ams?.enabled) {
      return null;
    }

    try {
      const amsGateway = (await import('../../gateways/ams'));
      const { buffer } = await amsGateway.fetchAssetVariation(resourceReference.ams, {
        mode: 'preview', // Для raw используем preview режим
      });

      // Возвращаем сырой буфер БЕЗ ensureImageProperties
      return buffer;
    } catch (error) {
      throw new Error(`AMS raw resource ${resourceReference.ams} failed: ${(error as Error).message}`);
    }
  }

  throw new Error(`Invalid resource reference: ${JSON.stringify(resourceReference)}`);
}
```

### 5. Реализовать url для AMS

**Файл:** `src/server/services/resources/storage.ts`

**Заменить throw на реализацию:**
```typescript
async function url(resourceReference: ResourceReference): Promise<string> {
  if (isValidGeneratorResourceReference(resourceReference)) {
    if (config.get().dev.serveResources) {
      return `/resources/${resourceReference.resourceRef}`;
    }
    return blobStorageClient.presignedUrl(resourceReference.resourceRef, { useCDN: true, useCache: true });
  }

  if (isValidAMSResourceReference(resourceReference)) {
    if (!config.get().ams?.enabled) {
      throw new Error(`AMS disabled, cannot generate URL for ${resourceReference.ams}`);
    }

    try {
      const amsGateway = (await import('../../gateways/ams'));
      const { blobRef } = await amsGateway.fetchAssetVariation(resourceReference.ams, {
        mode: 'preview', // Для URL используем preview режим
      });

      // Генерируем presigned URL через blob storage
      return blobStorageClient.presignedUrl(blobRef, { useCDN: true, useCache: true });
    } catch (error) {
      throw new Error(`AMS URL generation for ${resourceReference.ams} failed: ${(error as Error).message}`);
    }
  }

  throw new Error(`Invalid resource reference: ${JSON.stringify(resourceReference)}`);
}
```

### 6. Реализовать mapToURLs для AMS

**Файл:** `src/server/services/resources/storage.ts`

**Заменить throw на реализацию:**
```typescript
async function mapToURLs(resourceReference: ResourceReference): Promise<ResourceUrls> {
  if (isValidGeneratorResourceReference(resourceReference)) {
    const allRefs = getAllRefs(resourceReference);

    const resourceReferencesWithUrl = await Promise.all(
      allRefs.map(async (ref) => ({
        ...ref,
        url: await url(ref),
      })),
    );

    return Object.fromEntries(
      resourceReferencesWithUrl.map((resourceWithUrl: ResourceWithUrl) => [
        resourceWithUrl.resourceRef,
        resourceWithUrl.url,
      ]),
    );
  }

  if (isValidAMSResourceReference(resourceReference)) {
    if (!config.get().ams?.enabled) {
      return {};
    }

    try {
      // Для AMS ресурсов возвращаем один URL с assetId как ключ
      // ВАЖНО: ключ = assetId, НЕ resourceRef! Это отличается от generator ресурсов
      // Generator: { resourceRef: url }, AMS: { assetId: url }
      // ПРОВЕРИТЬ что потребители готовы к разным контрактам!
      const resourceUrl = await url(resourceReference);
      return {
        [resourceReference.ams]: resourceUrl, // ключ - это assetId
      };
    } catch (error) {
      throw new Error(`AMS URL mapping for ${resourceReference.ams} failed: ${(error as Error).message}`);
    }
  }

  throw new Error(`Invalid resource reference: ${JSON.stringify(resourceReference)}`);
}
```

## Тестирование

### 1. Создать unit тесты для helper

**Файл:** `test/unit/server/gateways/ams/fetchAssetVariation.test.ts`

```typescript
import { fetchAssetVariation } from '../../../../../src/server/gateways/ams';

describe('fetchAssetVariation', () => {
  it('should cache variation with deterministic key', async () => {
    // Mock blob storage, AMS gateway
    const result = await fetchAssetVariation('test-asset', { mode: 'preview' });

    // Проверяем формат ключа: ams/assetId/mode/scalingFactor/variationKey
    expect(result.blobRef).toMatch(/^ams\/test-asset\/preview\/default\/[a-f0-9]{8}$/);
    // Проверить что файл сохранен в blob storage
  });

  it('should reuse cached variation', async () => {
    // Первый вызов
    await fetchAssetVariation('test-asset', { mode: 'preview' });

    // Второй вызов должен взять из кэша
    const result = await fetchAssetVariation('test-asset', { mode: 'preview' });
    expect(result.buffer).toBeDefined();
    // Проверить что RabbitMQ не вызывался повторно
  });

  it('should handle different scaling factors', async () => {
    const result1 = await fetchAssetVariation('asset', { scalingFactor: 0.5 });
    const result2 = await fetchAssetVariation('asset', { scalingFactor: 1.0 });
    const result3 = await fetchAssetVariation('asset', { scalingFactor: 0 }); // edge case

    expect(result1.blobRef).toMatch(/^ams\/asset\/preview\/0\.500\/[a-f0-9]{8}$/);
    expect(result2.blobRef).toMatch(/^ams\/asset\/preview\/1\.000\/[a-f0-9]{8}$/);
    expect(result3.blobRef).toMatch(/^ams\/asset\/preview\/0\.000\/[a-f0-9]{8}$/);
  });

  it('should handle undefined options correctly', async () => {
    const result = await fetchAssetVariation('asset', {});

    // mode: undefined → 'preview', scalingFactor: undefined → 'default'
    expect(result.blobRef).toMatch(/^ams\/asset\/preview\/default\/[a-f0-9]{8}$/);
  });
});
```

### 2. Обновить интеграционные тесты

**Файл:** `test/server/integration/ams.test.ts`

**Добавить тесты:**
```typescript
describe('AMS URL/RAW support', () => {
  it('should return raw buffer via getRaw', async () => {
    const buffer = await resourceStorage.getRaw({ ams: 'image-asset-001' });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('should generate URL via url()', async () => {
    const urlResult = await resourceStorage.url({ ams: 'image-asset-001' });
    expect(urlResult).toMatch(/^https:\/\//);
    expect(urlResult).toContain('blob.core.windows.net');
  });

  it('should map to URLs via mapToURLs', async () => {
    const urls = await resourceStorage.mapToURLs({ ams: 'image-asset-001' });
    expect(urls['image-asset-001']).toMatch(/^https:\/\//);
  });

  it('should reuse cache between get() and getRaw()', async () => {
    // Вызвать get() для кэширования
    await resourceStorage.get({ ams: 'image-asset-001' }, { type: 'image' });

    // getRaw должен использовать тот же кэш
    const buffer = await resourceStorage.getRaw({ ams: 'image-asset-001' });
    expect(Buffer.isBuffer(buffer)).toBe(true);
  });
});
```

### 3. Обновить mock AMS

**Файл:** `test/support/server/fakeRemotes/fakeAMS.ts`

**Убедиться что variation.id присутствует в mock данных**

## Обработка ошибок и edge cases

### 1. AMS отключен
```typescript
if (!config.get().ams?.enabled) {
  // getRaw: return null
  // url/mapToURLs: throw Error с понятным сообщением
}
```

### 2. Нет подходящих вариаций
```typescript
if (!variation) {
  throw new Error(`No suitable variation found for asset ${assetId}`);
}
```

### 3. Ошибки blob storage
```typescript
try {
  await blobStorageClient.store(blobRef, buffer, mimeType);
} catch (error) {
  logger.logError(error, { context: 'AMS variation caching', blobRef });
  // Продолжаем работу, возвращаем buffer без кэширования
}
```

### 4. Ошибки скачивания
```typescript
try {
  const buffer = await downloadVariationBuffer(variation.url);
} catch (error) {
  throw new Error(`Failed to download AMS variation: ${error.message}`);
}
```

### 5. Критические edge cases
```typescript
// scalingFactor = 0 НЕ должен стать 'default' - используем !== undefined
const normalizedScalingFactor = options.scalingFactor !== undefined
  ? options.scalingFactor.toFixed(3)
  : 'default';

// variation.properties.width может отсутствовать
const width = variation.properties.width || 0;

// Проверка что blob storage поддерживает перезапись
// (должно работать "из коробки", но лучше протестировать)

// ВАЖНО: mapToURLs для AMS возвращает другой контракт чем для generator!
// Generator: { resourceRef: url }
// AMS: { assetId: url }
// Убедиться что потребители готовы к этому различию
```

## Логирование и мониторинг

### 1. Добавить логи в fetchAssetVariation
```typescript
logger.log('info', 'AMS variation cache hit', { assetId, blobRef });
logger.log('info', 'AMS variation cache miss, downloading', { assetId, blobRef });
logger.log('info', 'AMS variation cached successfully', { assetId, blobRef, bufferSize: buffer.length });
```

### 2. Добавить метрики (если нужно)
```typescript
// В otel spans при необходимости
otel.reportSpan('ams_variation_cache_hit', { assetId });
otel.reportSpan('ams_variation_download', { assetId, variationUrl });
```

## Конфигурация

### Никаких новых конфигов не требуется
- Используем существующий `config.ams.enabled`
- Используем существующий `blobStorage.urlExpirationTime` для TTL
- Azure lifecycle автоматически управляет старыми файлами

## Проверка готовности

### ✅ Критерии приемки:
1. `npm run typecheck` проходит без ошибок
2. Все существующие тесты проходят
3. Новые unit и integration тесты проходят
4. `getRaw({ ams: 'asset-id' })` возвращает Buffer
5. `url({ ams: 'asset-id' })` возвращает presigned URL
6. `mapToURLs({ ams: 'asset-id' })` возвращает объект с URL
7. Кэширование работает - повторные вызовы используют blob storage
8. Логи показывают cache hit/miss события

### ✅ Manual testing:
```typescript
// В Node.js REPL или test файле:
const storage = require('./src/server/services/resources/storage').default;

// Test getRaw
const buffer = await storage.getRaw({ ams: 'test-asset' });
console.log('Raw buffer size:', buffer.length);

// Test URL
const url = await storage.url({ ams: 'test-asset' });
console.log('Generated URL:', url);

// Test mapToURLs
const urls = await storage.mapToURLs({ ams: 'test-asset' });
console.log('URL mapping:', urls); // Ожидаем: { 'test-asset': 'https://...' }

// Test edge cases - getRaw принимает ТОЛЬКО resourceReference!
const buffer = await storage.getRaw({ ams: 'test-asset' });
console.log('Edge cases handled correctly');
```

## Финальные замечания

### Производительность
- Первый запрос: AMS request + download + blob store
- Последующие: только blob storage read (быстро)
- TTL управляется Azure, никакой ручной очистки

### Безопасность
- Все URL через наш blob storage с контролируемым TTL
- Никаких прямых ссылок на Freya
- Авторизация через существующие механизмы

### Совместимость
- Никаких breaking changes в API
- Существующий код продолжает работать
- AMS функциональность опциональна (`ams.enabled`)

---

**Этот план полностью самодостаточен и готов к реализации без дополнительных вопросов.**