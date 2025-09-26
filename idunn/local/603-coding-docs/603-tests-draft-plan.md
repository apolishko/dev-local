Когда будем писать тесты сфокусируемся на:

1. Unit тесты gateway компонентов:
   - test/unit/server/gateways/ams/internal/rpc.test.ts - RPC transport
   - test/unit/server/gateways/ams/response/parseResultMessage.test.ts - валидация ответов
   - test/unit/server/gateways/ams/index.test.ts - публичный API
2. Интеграционные тесты:
   - Mock RabbitMQ consumer для end-to-end проверки
   - ResourceStorage через gateway API
   - Выбор вариаций и HTTP скачивание
3. Тесты операций:
   - loadResource с новой 3-параметровой сигнатурой
   - selectFrameFromVideo без принудительного MP4

