#### Готовность AMS Gateway для ProRes поддержки ✅

Наша реализация AMS gateway уже полностью готова для следующего тикета ProRes поддержки:

1. Готовая логика выбора форматов

В src/server/gateways/ams/index.ts:107-113 уже реализована логика выбора вариаций:
- Order + ProRes: приоритет ProRes → fallback MP4
- Preview: ближайший MP4 по разрешению
- Настройка: preferProRes и mp4FallbackForOrders флаги

2. Контекстная передача через операции

- loadResource.ts:31-49 принимает scalingFactor из config
- OperationServices:26,38 содержит videoData?: VideoData и requestContext
- VideoData:8-13 содержит container: 'mp4' | 'mov'

3. Существующий routing по source

- loadResource.ts:37,40 поддерживает source === 'ams'
- ResourceStorage уже направляет AMS запросы в gateway

4. Что нужно добавить для ProRes тикета:

A) Расширить VideoData с контекстом заказа:

export type VideoData = {
fps: number;
container: 'mp4' | 'mov';
segments: VideoDataSegment[];
skipFrame?: number;
// NEW:
preferProRes?: boolean; // от VideoMacro через компилятор
mode?: 'preview' | 'order'; // browser vs server-side
};

B) Передать контекст в selectFrameFromVideo:

// в selectFrameFromVideo.ts добавить логику:
const videoData = services.videoData;
const mode = determineMode(services); // browser vs server  
const preferProRes = videoData?.preferProRes || false;

C) Обновить ResourceStorage для видео:

// При загрузке видео через AMS добавить:
const variationOptions = {
kind: 'video' as const,
mode: mode, // 'preview' | 'order'  
preferProRes: preferProRes
};

5. Архитектурные преимущества готовой реализации:

- ✅ Per-request exclusive queues исключают гонки
- ✅ Schema-first типизация с runtime валидацией
- ✅ Готовые алгоритмы выбора контейнеров и разрешений
- ✅ Поддержка многотенантности через context
- ✅ Centralized error handling и логирование
- ✅ Gateway изоляция от AMQP деталей

Вывод: AMS gateway архитектура полностью готова для ProRes тикета. Потребуются только минимальные изменения в VideoMacro/операциях для передачи контекста preferProRes + mode через VideoData и OperationServices.


Примечание:
```
Имеет ли смысл делать вносить минимальные изменения в VideoMacro/операциях для передачи контекста preferProRes + mode через VideoData и OperationServices сейчас или лучше это делать при работе непосредственно над тикетом ProRes, когда будут известны дополнительные детали?
```

● Лучше НЕ делать эти изменения заранее по нескольким причинам:

1. YAGNI принцип

Добавление preferProRes и mode в VideoData без четких требований может привести к неправильной абстракции, которую потом сложно изменить.

2. Неизвестные детали

- Как именно preferProRes будет определяться? (UI checkbox, template metadata, order context?)
- Нужен ли mode в VideoData или лучше определять его на уровне operation services?
- Какие еще параметры могут потребоваться для ProRes логики?

3. Риск over-engineering

Сейчас мы можем додумать не те интерфейсы. Лучше реализовать минимально необходимое при работе с конкретными требованиями.

4. Текущая архитектура уже готова

AMS gateway с правильным выбором вариаций уже реализован. Это основная сложность, а передача контекста - тривиальная задача.

5. Schema-first подход

Изменения в VideoData потребуют обновления YAML схем и регенерации типов. Лучше делать это один раз с полным пониманием требований.

Рекомендация: Оставить архитектуру как есть. При работе с ProRes тикетом добавить только необходимые поля с четким пониманием их использования.

Текущий AMS gateway полностью готов - это главное достижение тикета 603. ✅
