# AMS Integration Test Plan

## Цель

Создать полноценный интеграционный тест для AMS (Asset Management System) интеграции, который проверит весь pipeline от Load Resource операции до получения asset данных через RabbitMQ, включая новый wire-contract совместимый с production Freya.

## Что тестируем

### Полный integration pipeline:
1. **Load Resource operation** с параметром `source: 'ams'`
2. **AMS Gateway** - request формирование и отправка
3. **RabbitMQ communication** - request-reply pattern через per-request exclusive queues
4. **Wire-contract validation** - новые YAML схемы (request.yaml, response.yaml)
5. **Response parsing** - payload/error format без legacy `success` поля
6. **Variation selection** - выбор по `mimeType` только
7. **Asset download** - получение buffer данных

### Критические аспекты после рефакторинга:
- ✅ Exchange-based replies (не queue fallback)
- ✅ Freya `IRabbitResponse`/`IRabbitError` format
- ✅ Отсутствие `success` boolean field
- ✅ `mimeType`-only variation selection
- ✅ Schema validation на runtime

## Архитектура тестирования

### Использование существующей инфраструктуры:

**Docker Compose сеть:**
- `rabbitmq` сервис (уже настроен)
- `server` контейнер для запуска тестов
- Единая сеть для всех компонентов

**Паттерн Fake Remotes:**
- Аналогично `test/support/server/fakeRemotes/fakeComfyUI2.ts`
- Mock AMS через HTTP endpoint + RabbitMQ responses

**Тестовый фреймворк:**
- Vitest (уже используется)
- Supertest для HTTP запросов
- Реальный RabbitMQ connection

## Файловая структура

```
test/
├── support/
│   └── server/
│       └── fakeRemotes/
│           ├── fakeAMS.ts                    # NEW: Mock AMS implementation
│           └── fakeAMS/
│               ├── requestSchema.yaml        # NEW: Request validation
│               ├── responseSchema.yaml       # NEW: Response validation  
│               └── mockAssetData.json        # NEW: Test asset data
├── server/
│   └── integration/
│       └── ams.test.ts                       # NEW: Main integration test
└── fixtures/
    └── ams/
        ├── sample-image.png                  # NEW: Test variation files
        └── sample-video.mp4                  # NEW: Test variation files
```

## Детальный план реализации

### 1. Создание Mock AMS (fakeAMS.ts)

**Функциональность:**
```typescript
export function setupFakeAMS(): void {
  // HTTP endpoint для приема AMS requests
  webApp.get().post('/fake-remotes/ams/asset/:assetId', handleAssetRequest);
}

async function handleAssetRequest(req: Request, res: Response): Promise<void> {
  // 1. Валидировать request против YAML схемы
  // 2. Извлечь replyTo exchange/routingKey
  // 3. Отправить mock response через RabbitMQ
  // 4. Вернуть HTTP 202 Accepted
}
```

**RabbitMQ Response Logic:**
```typescript
async function sendMockResponse(replyTo: ReplyTo, requestId: string, assetId: string) {
  // Determine response type based on assetId
  if (assetId.startsWith('error-')) {
    // Send IRabbitError response
    await publishAMQPMessage(response, replyTo.exchangeName, replyTo.routingKey);
  } else {
    // Send IRabbitResponse with payload
    const mockAsset = loadMockAssetData(assetId);
    await publishAMQPMessage(successResponse, replyTo.exchangeName, replyTo.routingKey);
  }
}
```

### 2. Mock Asset Data (mockAssetData.json)

**Структура:**
```json
{
  "image-asset-001": {
    "id": "image-asset-001",
    "name": "Sample Image Asset",
    "variations": [
      {
        "id": "var-1", 
        "url": "http://server:8000/test/fixtures/ams/sample-image.png",
        "mimeType": "image/png",
        "width": 1920,
        "height": 1080
      },
      {
        "id": "var-2",
        "url": "http://server:8000/test/fixtures/ams/sample-image-small.png", 
        "mimeType": "image/png",
        "width": 960,
        "height": 540
      }
    ]
  },
  "video-asset-001": {
    "id": "video-asset-001",
    "name": "Sample Video Asset",
    "variations": [
      {
        "id": "var-1",
        "url": "http://server:8000/test/fixtures/ams/sample-video.mp4",
        "mimeType": "video/mp4",
        "width": 1920,
        "height": 1080,
        "duration": 30.5
      }
    ]
  },
  "error-asset-001": null
}
```

### 3. Schema Validation Files

**requestSchema.yaml:**
```yaml
# Copy exact structure from documentation/api/schemas/remote/ams/request.yaml
# Used for validating incoming requests in fake AMS
```

**responseSchema.yaml:**
```yaml  
# Copy exact structure from documentation/api/schemas/remote/ams/response.yaml
# Used for validating outgoing responses in fake AMS
```

### 4. Основной интеграционный тест (ams.test.ts)

**Test Structure:**
```typescript
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import app from '../../../src/server/app/index';
import { setupFakeAMS } from '../../support/server/fakeRemotes/fakeAMS';
import { runOperation } from '../../operations/helpers/common';

describe('AMS Integration Tests', () => {
  beforeAll(async () => {
    setupFakeAMS();
    await app.start({ runWeb: true });
  });

  afterAll(async () => {
    await app.stop();
  });

  describe('Load Resource with AMS source', () => {
    test('should successfully load image asset', async () => {
      // Test image asset loading
      const result = await runOperation('Load Resource', [
        'image',           // resourceType
        'image-asset-001', // resourceRef (assetId)
        'ams'             // source
      ]);
      
      expect(result).toBeInstanceOf(Buffer);
      // Verify image properties
    });

    test('should successfully load video asset', async () => {
      // Test video asset loading
    });

    test('should handle asset not found error', async () => {
      // Test error response handling
      const result = await runOperation('Load Resource', [
        'image',
        'error-asset-001', // This triggers error response
        'ams'
      ]);
      
      expect(result).toBeNull();
    });

    test('should select correct variation by mimeType', async () => {
      // Test variation selection logic
    });
  });

  describe('Wire Contract Validation', () => {
    test('should send request in correct Freya format', async () => {
      // Monitor RabbitMQ messages and validate structure
    });

    test('should handle response without success field', async () => {
      // Verify parsing works with new format
    });

    test('should use exchange-based reply only', async () => {
      // Verify no queue fallback attempts
    });
  });
});
```

### 5. Test Configuration

**config/test.json additions:**
```json
{
  "ams": {
    "enabled": "true",
    "requestQueue": "ams.request.test", 
    "responseExchange": "ams.reply.test",
    "timeout": "10000",
    "fallbackEnabled": "false"
  }
}
```

### 6. Test Fixtures

**Test files to create:**
- `test/fixtures/ams/sample-image.png` - 1920x1080 PNG
- `test/fixtures/ams/sample-image-small.png` - 960x540 PNG  
- `test/fixtures/ams/sample-video.mp4` - Short test video

## Запуск тестов

### Local Development:
```bash
# Start docker environment
docker-compose up -d rabbitmq postgres redis

# Run AMS integration tests
npm run test-ams-integration
```

### Package.json script addition:
```json
{
  "scripts": {
    "test-ams-integration": "npm run test-setup && vitest run test/server/integration/ams.test.ts"
  }
}
```

### Docker-based run:
```bash
# Run in docker environment (recommended)
docker-compose run --rm server npm run test-ams-integration
```

### CI/CD Integration:
```bash
# Add to existing paranoid script
npm run test-ams-integration
```

## Verification Points

### Что проверяем в тестах:

**1. Request Flow:**
- ✅ Load Resource operation принимает 3 параметра
- ✅ AMS Gateway формирует правильный request
- ✅ Request отправляется в correct queue
- ✅ Request structure соответствует новой YAML схеме
- ✅ ReplyTo содержит exchangeName/routingKey (не queue)

**2. Response Flow:**
- ✅ Mock AMS отвечает в правильном формате (payload/error)
- ✅ Response parsing работает без `success` field
- ✅ Error responses обрабатываются корректно
- ✅ Success responses возвращают asset data

**3. Variation Selection:**
- ✅ Filtering по mimeType работает
- ✅ Image vs video variations выбираются правильно
- ✅ Scaling factor учитывается при выборе
- ✅ ProRes preference работает для orders

**4. Asset Download:**
- ✅ Variation URL загружается
- ✅ Buffer возвращается правильного размера
- ✅ Image properties устанавливаются
- ✅ Timeout handling работает

**5. Error Scenarios:**
- ✅ Asset not found → null return
- ✅ Network timeouts → fallback/error
- ✅ Invalid response format → error
- ✅ Missing variations → error

## Maintenance

### Обновление тестов при изменениях:

**Schema changes:**
1. Обновить YAML файлы в `test/support/server/fakeRemotes/fakeAMS/`
2. Regenerate types: `npm run build-json-schema-types`
3. Update mock responses в `fakeAMS.ts`

**Gateway changes:**
1. Update test expectations
2. Add new test cases for new functionality
3. Verify backward compatibility

**Config changes:**
1. Update `config/test.json`
2. Verify test environment setup

## Benefits

### Почему этот тест важен:

**1. End-to-End Confidence:**
- Проверяет весь pipeline без внешних зависимостей
- Ловит integration bugs между компонентами
- Валидирует wire-contract compatibility

**2. Refactoring Safety:**
- Гарантирует, что изменения не ломают интеграцию
- Позволяет safely менять internal implementation
- Проверяет schema compatibility

**3. Development Velocity:**
- Быстрый feedback при изменениях
- Не требует доступа к external AMS
- Reproducible test scenarios

**4. Documentation:**
- Живая документация API contract
- Примеры usage patterns
- Reference для новых разработчиков

## Расширения в будущем

### Дополнительные сценарии:

**Load balancing:**
- Multiple AMS instances
- Failover scenarios

**Performance testing:**
- Concurrent requests
- Large asset handling
- Memory usage validation

**Security testing:**
- Malformed requests
- Authentication scenarios
- Schema validation bypass attempts

**Real AMS integration:**
- Feature flag для тестов с real AMS
- Staging environment validation
- Production compatibility checks

---

**Этот план является самодостаточным и покрывает все аспекты создания comprehensive AMS integration test suite, используя существующую инфраструктуру проекта.**