## 1. Понятие "Вариации" в контексте AMS тикета

### Что такое "Вариация" (Variation)

Вариация - это конкретное представление одного и того же asset'а в AMS в разных форматах, разрешениях или контейнерах.

Структура в нашей схеме

Согласно documentation/api/schemas/remote/ams/response.yaml:

```

AMSResponseVariation:


type: object
properties:
url:
type: string
description: "HTTP URL для скачивания вариации"
container:
type: string
description: "Формат контейнера: mp4, mov, jpg, png и т.д."
height:
type: integer
description: "Высота в пикселях"
width:
type: integer
description: "Ширина в пикселях"
```

Примеры вариаций одного asset'а
```
{
"assetId": "12345-video-asset",
"variations": [
{
"url": "https://ams.com/asset/12345/4k.mov",
"container": "mov",
"height": 2160,
"width": 3840
},
{
"url": "https://ams.com/asset/12345/1080p.mp4",
"container": "mp4",
"height": 1080,
"width": 1920
},
{
"url": "https://ams.com/asset/12345/720p.mp4",
"container": "mp4",
"height": 720,
"width": 1280
},
{
"url": "https://ams.com/asset/12345/thumb.jpg",
"container": "jpg",
"height": 200,
"width": 300
}
]
}
```

Логика выбора вариаций в нашем gateway

В src/server/gateways/ams/index.ts:107-174 реализованы алгоритмы выбора:

1. Для изображений (image):

// Ищем ближайшую высоту к target = 1080 * scalingFactor
const targetHeight = Math.round(1080 * (options.scalingFactor || 1));
// Выбираем variation с минимальной разницей по высоте

2. Для видео preview:

// MP4 с ближайшей высотой или максимальной
const mp4Variations = variations.filter(v => v.container === 'mp4');
// Сортируем по близости к целевой высоте

3. Для видео order с ProRes:

if (options.preferProRes) {
// 1. Ищем ProRes (mov контейнер)
const proResVariations = variations.filter(v => v.container === 'mov');
if (proResVariations.length > 0) return selectBest(proResVariations);

    // 2. Fallback на лучший MP4
    const mp4Variations = variations.filter(v => v.container === 'mp4');
    if (mp4Variations.length > 0) return selectBest(mp4Variations);
}

Зачем нужны вариации?

1. Производительность: Загружать 720p для preview вместо 4K
2. Совместимость: MP4 для web, ProRes для professional editing
3. Bandwidth: Выбор оптимального размера под задачу
4. Format requirements: Конкретные форматы для разных workflow

Практическое использование

// 1. Запрашиваем asset из AMS
const asset = await amsGateway.requestAssetById('12345');

// 2. Выбираем подходящую вариацию  
const variation = amsGateway.selectVariation(asset, {
kind: 'video',
mode: 'preview',
scalingFactor: 1.5
}); // Вернет 720p MP4

// 3. Скачиваем конкретную вариацию
const buffer = await amsGateway.downloadVariationBuffer(variation.url);

Итак, вариация = конкретный файл/формат одного логического ресурса в разных технических представлениях.


## 2.  HTTP скачивание в тикете 603

Зачем нужно HTTP скачивание?

AMS (Asset Management System) не передает сами файлы через RabbitMQ - это было бы неэффективно для больших видео/изображений.

Архитектура двухэтапного процесса:

1️⃣ RPC через RabbitMQ - получение метаданных

// Отправляем через MQ: "дай информацию об asset 12345"
const response = await rpcTransport.sendAndWait({
type: 'searchAssets',
payload: { query: { field: 'id', value: '12345' }}
});

// Получаем через MQ: метаданные + URLs
{
"asset": {
"id": "12345",
"variations": [
{
"url": "https://ams-storage.com/assets/12345/1080p.mp4",
"container": "mp4",
"height": 1080
}
]
}
}

2️⃣ HTTP скачивание - получение файла

// Скачиваем сам файл по HTTP URL из метаданных
const buffer = await downloadVariationBuffer(
"https://ams-storage.com/assets/12345/1080p.mp4"
);

Почему именно так?

RabbitMQ не подходит для больших файлов:

- ❌ 4K видео = гигабайты данных через очереди
- ❌ Таймауты и memory overhead
- ❌ Блокирование других сообщений

HTTP оптимален для файлов:

- ✅ Streaming download
- ✅ Resume/retry capabilities
- ✅ CDN/caching support
- ✅ Параллельные загрузки

Реализация в нашем коде:

В src/server/gateways/ams/index.ts:176-193:

export async function downloadVariationBuffer(
url: string,
timeoutMs: number = 30000
): Promise<Buffer> {

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
    });

    const buffer = Buffer.from(response.data);
    logger.log('info', 'AMS variation downloaded', {
      url,
      size: buffer.length
    });

    return buffer;
}

Полный workflow в ResourceStorage:

// 1. RPC: запрос метаданных  
const asset = await amsGateway.requestAssetById(assetId, context);

// 2. Логика: выбор оптимальной вариации
const variation = amsGateway.selectVariation(asset, options);

// 3. HTTP: скачивание файла
const buffer = await amsGateway.downloadVariationBuffer(variation.url);

// 4. Обработка: добавление метаданных изображения
return ensureImageProperties(buffer, resourceType);

Итог: HTTP скачивание отделяет легкие метаданные (RPC) от тяжелых файлов (HTTP), обеспечивая эффективную и масштабируемую архитектуру.
