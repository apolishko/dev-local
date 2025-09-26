## Error Handling and Monitoring Plan v2.0 (Self-Contained)

This document defines a self-contained, implementation-ready plan to add consistent error handling, correlation, masking, and mock monitoring to the API layer of the Pearson Career Explorer backend. It does not rely on any external guide. The import jobs (batch data import) are explicitly out of scope for now.

### Goals

- Introduce a unified, consistent error response format following RFC 7807 (Problem Details).
- Add correlation and request context (traceId, spanId, userId, orgId, environment, endpoint, method) via MDC for every API request.
- Implement a MonitoringService abstraction with a mock implementation that logs structured JSON events (later swappable to CloudWatch/OTEL).
- Enforce sensitive-data masking in logs and monitoring events.
- Standardize exception hierarchy to simplify mapping and monitoring.
- Add basic HTTP metrics and application error counters (mock), without requiring cloud access.
- Keep request/response bodies out of logs.
- Scope: API controllers and services invoked by them. Import jobs excluded.

### RFC 7807 Problem Responses

All API error responses MUST follow this structure (Problem+JSON):

- Fields (always present):
  - `type` (string URI): canonical URI for this error type, e.g. `https://docs.pce/errors/<error-code>`
  - `title` (string): short human-readable summary
  - `status` (int): HTTP status code
  - `instance` (string): request path (e.g., `/api/question-response`)
  - `timestamp` (ISO-8601): server time
  - `traceId` (string): correlation id for this request

- Additional fields:
  - For 4xx only: `detail` (string) — human-readable detail; omit detail for 5xx (use generic message)
  - Validation errors for request body (MethodArgumentNotValidException): `errors: [{ field, message }]`
  - Validation errors for query/path/params (ConstraintViolationException): `errors: [{ param, message }]`

Examples:

```json
{
  "type": "https://docs.pce/errors/validation",
  "title": "Validation Error",
  "status": 400,
  "detail": "Invalid request",
  "instance": "/api/question-response",
  "timestamp": "2025-08-08T09:42:31.123Z",
  "traceId": "6f7c1d4c8e7e4b1a",
  "errors": [{"field":"answers[0].value","message":"must be >= 0"}]
}
```

```json
{
  "type": "https://docs.pce/errors/internal-error",
  "title": "Internal Server Error",
  "status": 500,
  "instance": "/api/student-assessment/1/complete",
  "timestamp": "2025-08-08T09:42:31.123Z",
  "traceId": "6f7c1d4c8e7e4b1a"
}
```

#### Stable Error Type Slugs

Fix the canonical set of error type slugs and reuse them consistently across exceptions and responses:

- `validation` → 400
- `not-found` → 404
- `access-forbidden` → 403
- `conflict` → 409
- `database-locked` → 423
- `method-not-allowed` → 405
- `internal-error` → 500

The full URI is `https://docs.pce/errors/<slug>`.

ErrorType enum:
- Define `enum ErrorType { VALIDATION, NOT_FOUND, ACCESS_FORBIDDEN, CONFLICT, DATABASE_LOCKED, METHOD_NOT_ALLOWED, INTERNAL_ERROR }`
- Each enum constant exposes `slug()` returning the kebab-case value above, `getTitle()` for human-readable title, and `toUri()` returning `https://docs.pce/errors/<slug>`
- `AppException.type()` should return the enum (not raw string); `GlobalExceptionHandler` uses `type.toUri()`

### Correlation and MDC (Request Context)

#### Configuration
```properties
# Correlation mode: dual (support both headers) or single (one header only)
monitoring.correlation.mode=dual
# Header to use in single mode
monitoring.correlation.header=X-Correlation-Id
```

#### Behavior
- **Dual mode (default)**: Accept both `X-Correlation-Id` and `X-Request-Id` headers. Priority: `X-Request-Id` > `X-Correlation-Id`. Echo the same header name/value used for correlation.
- **Single mode**: Use only the header specified in `monitoring.correlation.header`. Accept and echo only that header.
- If no correlation header is present, generate UUID (short form acceptable for logs).
- Always store the chosen header name in MDC as `correlationHeader` for easier raw-log tracing.

#### MDC Keys
Maintain MDC keys for every request:
- `traceId` (the correlation id)
- `spanId` (random short id per request or per handler span)
- `userId` (from authenticated principal login; use `anonymous` if not authenticated)
- `orgId` (from authenticated principal organization; use `unknown` if not available)
- `environment` (dev/test/prod; from configuration)
- `endpoint` (request path)
- `method` (HTTP method)
- `correlationHeader` (string; either `X-Request-Id` or `X-Correlation-Id` or configured header)

Ensure MDC is always cleared in a `finally` block to avoid leakage across threads.

### Monitoring Abstraction (Mock First)

- Create `MonitoringService` interface with methods:
  - `void captureError(ErrorEvent event)`
  - `void captureMetric(MetricEvent metric)`
- Provide `MockMonitoringService` implementation:
  - Enabled via properties (default true in dev/test)
  - Emits structured JSON to application log (one line per event)
  - No external dependencies (cloud-agnostic)

#### ErrorEvent Schema (logged JSON)

```json
{
  "timestamp": "2025-08-08T09:42:31.123Z",
  "severity": "ERROR|WARN|FATAL",
  "transient": false,
  "httpStatus": 500,
  "endpoint": "/api/student-assessment/complete",
  "method": "POST",
  "traceId": "6f7c1d4c8e7e4b1a",
  "spanId": "a2f9c3",
  "userId": "student1@school1.com",
  "orgId": "school1",
  "environment": "dev",
  "exceptionType": "java.lang.RuntimeException",
  "exceptionMessage": "boom",
  "stack": "stacktrace-as-string (masked, truncated to 16KB)",
  "stackHash": "sha256-abcdef..."
}
```

**Stack trace processing order (CRITICAL):**
1. **FIRST**: Apply masking to entire stack trace
2. **SECOND**: Truncate masked stack to 16KB
3. **THIRD**: Compute hash (SHA-256) over the truncated, masked stack string

This ensures sensitive data is never included in hash computation or log output.

#### MetricEvent (initial set)

Use **Micrometer** directly for metrics collection:
- `http.request.duration` with tags `{service, version, endpoint, method, status_class}`
- `http_errors_total` with tags `{service, version, endpoint, method, status_class}`
- `application_errors_total` with tags `{service, version, exceptionType, severity}`

Latency collection:
- Use Micrometer Timer with histogram and percentiles (p95/p99) enabled.
- **CRITICAL**: Configure Timer with `.publishPercentiles(0.95, 0.99).publishPercentileHistogram(true)` to enable percentile calculation.
- Tags: `{service, version, endpoint, method}`; derive `status_class` from response code.
- `status_class` is computed as integer division: `status / 100` (e.g., 404→4, 500→5).

**Example Timer Configuration:**
```java
Timer.builder("http.request.duration")
    .description("HTTP request duration")
    .tags("service", serviceName, "version", version, "endpoint", endpoint, "method", method)
    .publishPercentiles(0.95, 0.99)
    .publishPercentileHistogram(true)
    .register(meterRegistry);
```

### Sensitive Data Masking

- Never log request/response bodies.
- Mask these keys in any messages or stack context prior to logging/monitoring:
  - Case-insensitive: `authorization`, `token`, `password`, `secret`, `apiKey`, `api-key`, `apikey`.
- Provide `SensitiveDataMasker.mask(String)` utility used by `MockMonitoringService` and exception handler before emitting data.
- Additionally, run all exception messages and textual fields through the masker, even if they originate from third-party libraries, to avoid leaking secrets.

### Exception Hierarchy

- Introduce `AppException` base class with:
  - `HttpStatus status()` (or numeric code)
  - `ErrorType type()` (enum, not string)
  - `boolean transientFailure()` default `false` (override with `true` for retryable conditions like DB lock)
  - Optionally `String safeMessage()` (message safe to expose in 4xx `detail`)
- Adapt existing exceptions to extend `AppException`:
  - `ValidationException` → 400, type `VALIDATION`
  - `ResourceNotFoundException` → 404, type `NOT_FOUND`
  - `AccessForbiddenException` → 403, type `ACCESS_FORBIDDEN`
  - `AssessmentAlreadyCompletedException` → 409, type `CONFLICT`
  - `DatabaseLockException` → 423, type `DATABASE_LOCKED`, `transientFailure=true`

### GlobalExceptionHandler Behavior

- For `AppException`:
  - Build Problem+JSON using `status()`/`type().toUri()` and add `timestamp`, `instance`, `traceId`.
  - For 4xx include `detail` from `safeMessage()`; for 5xx use generic message.
  - Map to monitoring severity: 4xx → `WARN`, 5xx → `ERROR`.
  - If `transientFailure()==true`, set `transient=true` in `ErrorEvent`.
- Severity policy (fixed):
  - 4xx → WARN, no alerts
  - 5xx or unknown → ERROR, alert candidates
  - 423 (`database-locked`) → WARN + `transient=true` (for retries/dashboards, per PCE specification)
  - **Optional**: Add `Retry-After: <seconds>` header for 423 responses to hint retry timing.
- For `MethodArgumentNotValidException` (body validation):
  - 400; `errors: [{field, message}]`.
- For `ConstraintViolationException` (params validation):
  - 400; `errors: [{param, message}]`.
- For `AccessDeniedException` (Spring Security):
  - 403; generic detail.
- For `HttpRequestMethodNotSupportedException`:
  - 405; type `method-not-allowed`; include optional `allowedMethods: ["GET","POST",...]` in ProblemDetail properties.
  - **MUST** set HTTP header `Allow: GET, POST, ...` with supported methods (RFC standard).
- For `MissingServletRequestParameterException`:
  - 400; type `validation`; include `errors: [{param, message}]` with the missing parameter name.
- For any other `Exception`:
  - 500; generic message, severity `ERROR`, type `internal-error`.
- Always include `traceId` and `timestamp` in response.
- Always capture `ErrorEvent` via `MonitoringService` with masked fields.
- Log exactly once at the top-level handler (no duplicate logging or rethrow-logging in lower layers).

### ProblemDetails Builder Utility

Create utility class to reduce duplication:

```java
public class ProblemDetailBuilder {
    public static ProblemDetail create(ErrorType type, HttpStatus status, String instance) {
        // Use ProblemDetail.forStatus() + setType() for Spring 6 compatibility
        ProblemDetail problem = ProblemDetail.forStatus(status);
        problem.setType(URI.create(type.toUri()));
        problem.setTitle(type.getTitle());
        problem.setProperty("timestamp", Instant.now());
        problem.setProperty("traceId", MDC.get("traceId"));
        problem.setInstance(URI.create(instance));
        return problem;
    }
    
    public static ProblemDetail createWithDetail(ErrorType type, HttpStatus status, 
                                                String instance, String detail) {
        ProblemDetail problem = create(type, status, instance);
        problem.setDetail(detail);
        return problem;
    }
}
```

### Request Context Filter

- `OncePerRequestFilter` responsibilities:
  - Read `monitoring.correlation.mode` and `monitoring.correlation.header` configuration
  - **Dual mode**: Extract correlation id (prefer `X-Request-Id`, then `X-Correlation-Id`)
  - **Single mode**: Extract only the configured header
  - Generate UUID if no correlation header is present
  - Put all MDC keys (traceId, spanId, userId, orgId, environment, endpoint, method, correlationHeader)
  - Add correlation id to the response header (mirror inbound header name if present, otherwise use configured default)
  - Clear MDC in `finally`

Note on async/task execution:
- TODO (Phase 4–5): add a Spring `TaskDecorator` to propagate and clear MDC across `@Async` and thread pools.

### HTTP Metrics (Phase 2)

- Use **Micrometer Timer and Counter** directly:
  - Timer for `http.request.duration` (histogram summary) — compute p95/p99
  - Counter for `http_errors_total{status_class, endpoint, method}` — increment for 4xx/5xx
- On error capture: increment `application_errors_total{exceptionType, severity}`
- In mock mode: emit metrics as structured JSON lines (MetricEvent) or as INFO log with a well-known prefix

### Security and Logging Rules

- Do not log bodies or personally identifiable content.
- Mask sensitive keys in all emitted strings.
- Stack traces are allowed only in logs/monitoring, never in HTTP responses.
- When `monitoring.enabled=false`, RFC7807 responses are still returned; `MonitoringService` becomes a no-op.

### Configuration

Properties (with sane defaults):
```properties
# Monitoring
monitoring.enabled=true
monitoring.mock=true
monitoring.masking.enabled=true
monitoring.environment=dev

# Correlation
monitoring.correlation.mode=dual
monitoring.correlation.header=X-Correlation-Id
```

Switching to real backend later: provide alternative `MonitoringService` bean (CloudWatch/OTEL) and disable mock.

### Non-API Failures (Optional Early Hardening)

- Register a `DefaultUncaughtExceptionHandler` at application startup:
  - On uncaught exceptions, build `ErrorEvent` with `severity=FATAL` and capture via `MonitoringService`.
  - This covers background threads or future tasks outside the web layer.

### Implementation Checklist (Incremental)

1) **Iteration 1: Core plumbing**
- Add `MonitoringService`, `MockMonitoringService`, `ErrorEvent`, `MetricEvent`, `SensitiveDataMasker`.
- Add `RequestContextFilter` with configurable correlation header support (MDC + correlation header).
- Create `ProblemDetailBuilder` utility class.
- Update `GlobalExceptionHandler`:
  - RFC7807 fields (type, title, status, instance, timestamp, traceId).
  - detail only for 4xx; generic for 5xx.
  - capture errors via `MonitoringService` with severity mapping and transient flag.

2) **Iteration 2: Validation fidelity and masking**
- Distinguish body vs param validation:
  - `MethodArgumentNotValidException` → `errors[{field,message}]`.
  - `ConstraintViolationException` → `errors[{param,message}]`.
- Implement correct stack trace processing order: masking → truncation → hash.
- Ensure masking is applied to all error messages before logging/emitting.

3) **Iteration 3: Metrics with Micrometer**
- Hook latency and status collection (filter or interceptor) using Micrometer Timer/Counter.
- **CRITICAL**: Configure Timer with `.publishPercentiles(0.95, 0.99).publishPercentileHistogram(true)`.
- Maintain counters `http_errors_total` and `application_errors_total` with proper tags.
- Add `Allow` header for 405 responses and optional `Retry-After` for 423 responses.

4) **Iteration 4: Global safety net**
- Add `DefaultUncaughtExceptionHandler` → `severity=FATAL` into `MonitoringService`.

5) **Iteration 5: (Optional) JSON logging backend**
- Add logback JSON encoder or keep JSON emission in `MockMonitoringService`.

### File/Package Changes (Summary)

- New package: `com.pearson.pce.monitoring`
  - `MonitoringService` (interface)
  - `MockMonitoringService` (bean)
  - `model.ErrorEvent`, `model.MetricEvent`
  - `RequestContextFilter` (bean)
  - `SensitiveDataMasker` (utility)
  - `ProblemDetailBuilder` (utility)
- New base exception: `com.pearson.pce.exception.AppException`
- New enum: `com.pearson.pce.exception.ErrorType`
- Adapt existing exceptions to extend `AppException` (optionally in a later pass; handler supports both styles).
- Update `com.pearson.pce.api.GlobalExceptionHandler` to the rules above.
- Add properties under `monitoring.*` in `application.properties` (safe defaults).

### Acceptance Criteria

- Every API error response contains: `type`, `title`, `status`, `instance`, `timestamp`, `traceId`.
- 4xx responses contain appropriate `detail`; 5xx responses do not expose internal details.
- Validation errors are split: body → `errors[{field,message}]`, params → `errors[{param,message}]`.
- Response headers echo correlation id according to configured mode (dual/single).
- Logs show one JSON `ErrorEvent` per handled error, with masked sensitive fields.
- Stack trace processing follows correct order: masking → truncation → hash.
- MDC keys are present for all requests with null-safe values (`anonymous`/`unknown`) and cleared after each request.
- Metrics use Micrometer directly with proper tags `{service, version, endpoint, method, status_class}`.
- Fixed severity policy is applied (4xx=WARN, 5xx/unknown=ERROR; 423=WARN+transient=true per PCE spec).
- When monitoring is disabled, RFC7807 behavior remains intact and no monitoring output is emitted.
- All `MetricEvent` instances MUST include `service` and `version` tags; events missing these tags are considered invalid.
- ProblemDetailBuilder reduces code duplication in exception handler.

### Test Plan

- Unit tests:
  - `GlobalExceptionHandler` mapping for each exception class; presence of RFC7807 fields.
  - Validation mapping: body vs params.
  - Masker tests for sensitive keys.
  - Stack trace processing order: masking → truncation → hash.
  - MonitoringService mock invocation with proper severity/transient flags.
  - ProblemDetailBuilder utility methods.
  - RequestContextFilter with dual/single correlation modes.
- Integration tests:
  - Correlation propagation: custom correlation headers echoed back and present in response JSON and logs.
  - 423 locked path sets `transient=true` in `ErrorEvent`.
  - 5xx path never includes `detail` in the response.
  - MDC null-safe values for unauthenticated requests.
- E2E (smoke):
  - Trigger 400, 403, 404, 409, 423, 500 and verify responses + one error event per failure.

### Migration to Real Monitoring (Later)

- Provide CloudWatch/OTEL implementation of `MonitoringService` using the same `ErrorEvent`/`MetricEvent` contracts.
- Disable `MockMonitoringService` via properties.
- Consider migrating from custom MetricEvent to pure Micrometer integration.
- Optionally switch logging to JSON encoder and forward to a collector.

### Key Changes from v1.0

1. **Configurable correlation headers**: Added `monitoring.correlation.mode` (dual/single) and `monitoring.correlation.header`
2. **Stack trace processing order**: Clarified critical sequence: masking → truncation → hash
3. **MDC null-safety**: Use `anonymous`/`unknown` for missing userId/orgId
4. **HTTP 423 retention**: Keep per PCE specification requirement, with transient flag
5. **ProblemDetailBuilder**: Added utility to reduce code duplication
6. **Micrometer emphasis**: Direct integration instead of custom metric events where possible
7. **ErrorType enum**: Return enum from AppException.type(), convert to URI in handler

### Key Changes from v2.0 to v2.1

8. **Spring 6 compatibility**: Updated ProblemDetailBuilder to use `ProblemDetail.forStatus()` + `setType()`
9. **ErrorType.getTitle()**: Added title mapping requirement for enum constants
10. **HTTP 405 Allow header**: Added mandatory `Allow` header for method not allowed responses (RFC compliance)
11. **HTTP 423 Retry-After**: Added optional `Retry-After` header for database lock responses
12. **Micrometer percentiles**: Added critical configuration for `.publishPercentiles()` and `.publishPercentileHistogram(true)`

---

## APPENDIX: Implementation File Checklist

This appendix provides a comprehensive, ready-to-implement file checklist for the error handling plan v2.1. Use this list to systematically implement all required changes without missing any components.

### 🆕 **NEW FILES TO CREATE (15 files)**

#### **Core Monitoring System**
1. **`src/main/java/com/pearson/pce/monitoring/MonitoringService.java`**
   - Interface with `captureError(ErrorEvent)` and `captureMetric(MetricEvent)` methods
   - Abstraction for swapping mock → real monitoring later

2. **`src/main/java/com/pearson/pce/monitoring/MockMonitoringService.java`**  
   - Implementation that logs structured JSON to application log
   - Enabled via `monitoring.mock=true` property
   - No external dependencies, cloud-agnostic

3. **`src/main/java/com/pearson/pce/monitoring/RequestContextFilter.java`**
   - `OncePerRequestFilter` for correlation headers and MDC context
   - Implements dual/single correlation mode logic
   - Integrates Micrometer Timer/Counter for HTTP metrics
   - Manages MDC lifecycle (populate → clear in finally)

4. **`src/main/java/com/pearson/pce/monitoring/SensitiveDataMasker.java`**
   - Utility class with `mask(String)` method
   - Masks: authorization, token, password, secret, apiKey, api-key, apikey
   - Used by monitoring service and exception handler

5. **`src/main/java/com/pearson/pce/monitoring/ProblemDetailBuilder.java`**
   - Utility for RFC7807 ProblemDetail construction
   - Spring 6 compatible: `ProblemDetail.forStatus()` + `setType()`
   - Methods: `create()` and `createWithDetail()`

#### **Event Models**
6. **`src/main/java/com/pearson/pce/monitoring/model/ErrorEvent.java`**
   - POJO for structured error event JSON
   - Fields: timestamp, severity, transient, httpStatus, endpoint, method, traceId, spanId, userId, orgId, environment, exceptionType, exceptionMessage, stack, stackHash

7. **`src/main/java/com/pearson/pce/monitoring/model/MetricEvent.java`**
   - POJO for structured metric event JSON (if needed beyond direct Micrometer)
   - May be minimal if using Micrometer directly

#### **Exception System**  
8. **`src/main/java/com/pearson/pce/exception/AppException.java`**
   - Base exception class with methods:
   - `HttpStatus status()`, `ErrorType type()`, `boolean transientFailure()`, `String safeMessage()`

9. **`src/main/java/com/pearson/pce/exception/ErrorType.java`**  
   - Enum with constants: VALIDATION, NOT_FOUND, ACCESS_FORBIDDEN, CONFLICT, DATABASE_LOCKED, METHOD_NOT_ALLOWED, INTERNAL_ERROR
   - Methods: `slug()`, `getTitle()`, `toUri()`

#### **Configuration**
10. **`src/main/java/com/pearson/pce/monitoring/MonitoringConfig.java`**
    - Spring configuration for monitoring beans
    - Bean definitions for MonitoringService, RequestContextFilter
    - Micrometer MeterRegistry configuration

11. **`src/main/java/com/pearson/pce/monitoring/MonitoringProperties.java`**
    - `@ConfigurationProperties(prefix = "monitoring")` class  
    - Properties: enabled, mock, masking.enabled, environment, correlation.mode, correlation.header

### 🔧 **FILES TO MODIFY (14 files)**

#### **Core Exception Handling**
1. **`src/main/java/com/pearson/pce/api/GlobalExceptionHandler.java`** - **MAJOR REWRITE**
   - Complete RFC7807 Problem Details implementation
   - Integration with MonitoringService for error events
   - Correlation traceId in all responses
   - Severity mapping (4xx=WARN, 5xx=ERROR, 423=WARN+transient)
   - Stack trace processing: masking → truncation → hash
   - HTTP headers: Allow for 405, optional Retry-After for 423
   - Validation error mapping: body vs params

#### **API Documentation**  
2. **`src/main/java/com/pearson/pce/api/annotation/CommonErrorResponses.java`**
   - Update all example JSON responses to RFC7807 format
   - Add `traceId` field to all examples
   - Change error type URIs from `https://pearson.com/errors/` to `https://docs.pce/errors/`
   - Update response structure to match ProblemDetail format

#### **Security Integration**
3. **`src/main/java/com/pearson/pce/security/SecurityConfig.java`**
   - Add RequestContextFilter to security filter chain:
   - `.addFilterBefore(requestContextFilter, authFilter.getClass())`
   - Ensure proper filter ordering for correlation before authentication

#### **Exception Classes (extend AppException)**  
4. **`src/main/java/com/pearson/pce/exception/ValidationException.java`**
   - Extend AppException, implement status()=400, type()=VALIDATION

5. **`src/main/java/com/pearson/pce/exception/ResourceNotFoundException.java`**
   - Extend AppException, implement status()=404, type()=NOT_FOUND

6. **`src/main/java/com/pearson/pce/exception/AccessForbiddenException.java`**  
   - Extend AppException, implement status()=403, type()=ACCESS_FORBIDDEN

7. **`src/main/java/com/pearson/pce/exception/AssessmentAlreadyCompletedException.java`**
   - Extend AppException, implement status()=409, type()=CONFLICT

8. **`src/main/java/com/pearson/pce/exception/DatabaseLockException.java`**
   - Extend AppException, implement status()=423, type()=DATABASE_LOCKED, transientFailure()=true

#### **Configuration Files**
9. **`src/main/resources/application.properties`** 
   - Add monitoring configuration block:
   ```properties
   # Monitoring
   monitoring.enabled=true
   monitoring.mock=true
   monitoring.masking.enabled=true
   monitoring.environment=dev
   # Correlation  
   monitoring.correlation.mode=dual
   monitoring.correlation.header=X-Correlation-Id
   ```

10. **`src/main/java/com/pearson/pce/PearsonCareerExplorerApplication.java`**
    - Add DefaultUncaughtExceptionHandler for background thread errors
    - Setup FATAL error event capture via MonitoringService

11. **`build.gradle`**
    - Add Micrometer dependency:
    ```gradle
    implementation 'io.micrometer:micrometer-core'
    implementation 'io.micrometer:micrometer-registry-prometheus' // or chosen registry
    ```

#### **Environment Files (Optional)**
12. **`.env.development`** - Add monitoring properties section
13. **`.env.production`** - Add monitoring properties section  
14. **`.env.testing`** - Add monitoring properties section

### ❓ **POTENTIALLY DEPRECATED FILES (2 files)**

Review and potentially remove if fully replaced by ProblemDetail:

1. **`src/main/java/com/pearson/pce/api/dto/ErrorResponse.java`**
   - May be removed if no longer used after ProblemDetail migration

2. **`src/main/java/com/pearson/pce/api/dto/ValidationErrorResponse.java`**  
   - May be removed if no longer used after ProblemDetail migration

### 📊 **IMPLEMENTATION STATISTICS**

- **15 NEW files**: Complete monitoring and error handling system
- **14 MODIFIED files**: Integration with existing architecture
- **2 POTENTIALLY REMOVED files**: Legacy error DTOs
- **0 SECURITY CHANGES**: Authentication system remains untouched

### 🚀 **IMPLEMENTATION ORDER**

**Phase 1: Core Infrastructure**
1. Create monitoring package structure and interfaces
2. Implement MockMonitoringService and event models
3. Create AppException hierarchy and ErrorType enum
4. Build ProblemDetailBuilder utility

**Phase 2: Integration** 
1. Rewrite GlobalExceptionHandler with full RFC7807 support
2. Add RequestContextFilter to security chain
3. Update existing exceptions to extend AppException
4. Add monitoring properties to configuration

**Phase 3: Enhancements**
1. Update API documentation examples
2. Add Micrometer dependency and HTTP metrics  
3. Implement UncaughtExceptionHandler
4. Test and validate all error scenarios

**Phase 4: Cleanup**
1. Remove deprecated error DTO classes if unused
2. Verify all acceptance criteria
3. Run comprehensive test suite

### ✅ **IMPLEMENTATION VALIDATION**

After implementation, verify:
- [ ] All error responses follow RFC7807 format with traceId
- [ ] Correlation headers work in dual/single modes  
- [ ] MDC context populates correctly with null-safe values
- [ ] Stack trace processing: masking → truncation → hash
- [ ] Micrometer metrics collect with proper tags
- [ ] HTTP headers: Allow for 405, Retry-After for 423
- [ ] Severity policy: 4xx=WARN, 5xx=ERROR, 423=WARN+transient
- [ ] MockMonitoringService logs structured JSON events
- [ ] Sensitive data masking works correctly
- [ ] All validation errors map to correct format

This checklist ensures complete, systematic implementation of error handling plan v2.1 without omissions.