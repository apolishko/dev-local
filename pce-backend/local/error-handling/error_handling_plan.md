## Error Handling and Monitoring Plan (Self-Contained)

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
- Each enum constant exposes `slug()` returning the kebab-case value above, and `toUri()` returning `https://docs.pce/errors/<slug>`.
- `AppException.type()` should return the enum (not raw string); `GlobalExceptionHandler` uses `type.toUri()`.

### Correlation and MDC (Request Context)

- Accept `X-Correlation-Id` or `X-Request-Id` header. If missing, generate UUID (short form acceptable for logs).
- Rule (echo): If the request used `X-Request-Id`, respond with `X-Request-Id`; otherwise use `X-Correlation-Id` for both request and response.
- Priority policy: if both headers are present, `X-Request-Id` takes precedence; always echo the same header name/value that was used for correlation.
  - Also store the chosen header name in MDC as `correlationHeader` for easier raw-log tracing.
- Maintain MDC keys for every request:
  - `traceId` (the correlation id)
  - `spanId` (random short id per request or per handler span)
  - `userId` (from authenticated principal login)
  - `orgId` (from authenticated principal organization)
  - `environment` (dev/test/prod; from configuration)
  - `endpoint` (request path)
  - `method` (HTTP method)
  - `correlationHeader` (string; either `X-Request-Id` or `X-Correlation-Id`)
- Ensure MDC is always cleared in a `finally` block to avoid leakage across threads.

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

Stack trace policy:
- ALWAYS MASK stack traces; NEVER include request/response bodies.
- Truncate stack to 16KB BEFORE computing the hash.
- Compute a stable `stackHash` (e.g., SHA-256) over the TRUNCATED stack string to correlate duplicates.
 - Note: hashes of different stacks longer than 16KB that share the same prefix may collide; optionally add `firstLineHash` to improve deduplication.

#### MetricEvent (initial set)

- `http_request_duration_ms` with tags {service, version, endpoint, method, status_class}
- `http_errors_total` with tags {service, version, endpoint, method, status_class}
- `application_errors_total` with tags {service, version, exceptionType, severity}

Latency collection:
- Use Micrometer Timer with histogram and percentiles (p95/p99) enabled locally.
- Tags: `{service, version, endpoint, method}`; derive `status_class` from response code.
- `status_class` is computed as integer division: `status / 100` (e.g., 404→4, 500→5).

### Sensitive Data Masking

- Never log request/response bodies.
- Mask these keys in any messages or stack context prior to logging/monitoring:
  - Case-insensitive: `authorization`, `token`, `password`, `secret`, `apiKey`, `api-key`, `apikey`.
- Provide `SensitiveDataMasker.mask(String)` utility used by `MockMonitoringService` and exception handler before emitting data.
- Additionally, run all exception messages and textual fields through the masker, even if they originate from third-party libraries, to avoid leaking secrets.

### Exception Hierarchy

- Introduce `AppException` base class with:
  - `HttpStatus status()` (or numeric code)
- `String type()` (URI suffix, one of: `validation`, `not-found`, `access-forbidden`, `conflict`, `database-locked`, `method-not-allowed`, `internal-error`)
- `boolean transientFailure()` default `false` (override with `true` for retryable conditions like DB lock)
  - Optionally `String safeMessage()` (message safe to expose in 4xx `detail`)
- Adapt existing exceptions to extend `AppException`:
  - `ValidationException` → 400, type `validation`
  - `ResourceNotFoundException` → 404, type `not-found`
  - `AccessForbiddenException` → 403, type `access-forbidden`
  - `AssessmentAlreadyCompletedException` → 409, type `conflict`
  - `DatabaseLockException` → 423, type `database-locked`, `transientFailure=true`

### GlobalExceptionHandler Behavior

- For `AppException`:
  - Build Problem+JSON using `status()`/`type()` and add `timestamp`, `instance`, `traceId`.
  - For 4xx include `detail` from `safeMessage()`; for 5xx use generic message.
  - Map to monitoring severity: 4xx → `WARN`, 5xx → `ERROR`.
  - If `transientFailure()==true`, set `transient=true` in `ErrorEvent`.
- Severity policy (fixed):
  - 4xx → WARN, no alerts
  - 5xx or unknown → ERROR, alert candidates
  - 423 (`database-locked`) → WARN + `transient=true` (for retries/dashboards)
- For `MethodArgumentNotValidException` (body validation):
  - 400; `errors: [{field, message}]`.
- For `ConstraintViolationException` (params validation):
  - 400; `errors: [{param, message}]`.
- For `AccessDeniedException` (Spring Security):
  - 403; generic detail.
- For `HttpRequestMethodNotSupportedException`:
  - 405; type `method-not-allowed`; include optional `allowedMethods: ["GET","POST",...]` in ProblemDetail properties.
- For `MissingServletRequestParameterException`:
  - 400; type `validation`; include `errors: [{param, message}]` with the missing parameter name.
- For any other `Exception`:
  - 500; generic message, severity `ERROR`, type `internal-error`.
- Always include `traceId` and `timestamp` in response.
- Always capture `ErrorEvent` via `MonitoringService` with masked fields.
- Log exactly once at the top-level handler (no duplicate logging or rethrow-logging in lower layers).

### Request Context Filter

- `OncePerRequestFilter` responsibilities:
  - Extract or generate correlation id (prefer `X-Correlation-Id`, then `X-Request-Id`).
  - Put all MDC keys (traceId, spanId, userId, orgId, environment, endpoint, method).
  - Add correlation id to the response header (mirror inbound header name if present, otherwise `X-Correlation-Id`).
  - Clear MDC in `finally`.

Note on async/task execution:
- TODO (Phase 4–5): add a Spring `TaskDecorator` to propagate and clear MDC across `@Async` and thread pools.

### HTTP Metrics (Phase 2)

- Measure per-request latency and status, publish:
  - `http_request_duration_ms` (histogram summary) — compute p95/p99 offline from logs or in-memory summary.
  - `http_errors_total{status_class, endpoint, method}` — increment for 4xx/5xx.
- On error capture: increment `application_errors_total{exceptionType, severity}`.
- In mock mode: emit metrics as structured JSON lines (MetricEvent) or as INFO log with a well-known prefix.

### Security and Logging Rules

- Do not log bodies or personally identifiable content.
- Mask sensitive keys in all emitted strings.
- Stack traces are allowed only in logs/monitoring, never in HTTP responses.
- When `monitoring.enabled=false`, RFC7807 responses are still returned; `MonitoringService` becomes a no-op.

### Configuration

- Properties (with sane defaults):
  - `monitoring.enabled=true`
  - `monitoring.mock=true`
  - `monitoring.masking.enabled=true`
  - `monitoring.environment=dev` (or derived from existing env)
- Switching to real backend later: provide alternative `MonitoringService` bean (CloudWatch/OTEL) and disable mock.

### Non-API Failures (Optional Early Hardening)

- Register a `DefaultUncaughtExceptionHandler` at application startup:
  - On uncaught exceptions, build `ErrorEvent` with `severity=FATAL` and capture via `MonitoringService`.
  - This covers background threads or future tasks outside the web layer.

### Implementation Checklist (Incremental)

1) Iteration 1: Core plumbing
- Add `MonitoringService`, `MockMonitoringService`, `ErrorEvent`, `MetricEvent`, `SensitiveDataMasker`.
- Add `RequestContextFilter` (MDC + correlation header).
- Update `GlobalExceptionHandler`:
  - RFC7807 fields (type, title, status, instance, timestamp, traceId).
  - detail only for 4xx; generic for 5xx.
  - capture errors via `MonitoringService` with severity mapping and transient flag.

2) Iteration 2: Validation fidelity and masking
- Distinguish body vs param validation:
  - `MethodArgumentNotValidException` → `errors[{field,message}]`.
  - `ConstraintViolationException` → `errors[{param,message}]`.
- Ensure masking is applied to all error messages before logging/emitting.

3) Iteration 3: Metrics (mock)
- Hook latency and status collection (filter or interceptor) → emit `MetricEvent`.
- Maintain counters `http_errors_total` and `application_errors_total`.

4) Iteration 4: Global safety net
- Add `DefaultUncaughtExceptionHandler` → `severity=FATAL` into `MonitoringService`.

5) Iteration 5: (Optional) JSON logging backend
- Add logback JSON encoder or keep JSON emission in `MockMonitoringService`.

### File/Package Changes (Summary)

- New package: `com.pearson.pce.monitoring`
  - `MonitoringService` (interface)
  - `MockMonitoringService` (bean)
  - `model.ErrorEvent`, `model.MetricEvent`
  - `RequestContextFilter` (bean)
  - `SensitiveDataMasker` (utility)
- New base exception: `com.pearson.pce.exception.AppException`
- Adapt existing exceptions to extend `AppException` (optionally in a later pass; handler supports both styles).
- Update `com.pearson.pce.api.GlobalExceptionHandler` to the rules above.
- Add properties under `monitoring.*` in `application.properties` (safe defaults).

### Acceptance Criteria

- Every API error response contains: `type`, `title`, `status`, `instance`, `timestamp`, `traceId`.
- 4xx responses contain appropriate `detail`; 5xx responses do not expose internal details.
- Validation errors are split: body → `errors[{field,message}]`, params → `errors[{param,message}]`.
- Response headers echo correlation id.
- Logs show one JSON `ErrorEvent` per handled error, with masked sensitive fields.
- MDC keys are present for all requests and cleared after each request.
- Metrics (mock) are emitted for errors and request durations.
- Fixed severity policy is applied (4xx=WARN, 5xx/unknown=ERROR; 423=WARN+transient=true).
- When monitoring is disabled, RFC7807 behavior remains intact and no monitoring output is emitted.
 - All `MetricEvent` instances MUST include `service` and `version` tags; events missing these tags are considered invalid.

### Test Plan

- Unit tests:
  - `GlobalExceptionHandler` mapping for each exception class; presence of RFC7807 fields.
  - Validation mapping: body vs params.
  - Masker tests for sensitive keys.
  - MonitoringService mock invocation with proper severity/transient flags.
- Integration tests:
  - Correlation propagation: custom `X-Correlation-Id` echoed back and present in response JSON and logs.
  - 423 locked path sets `transient=true` in `ErrorEvent`.
  - 5xx path never includes `detail` in the response.
- E2E (smoke):
  - Trigger 400, 403, 404, 409, 423, 500 and verify responses + one error event per failure.

### Migration to Real Monitoring (Later)

- Provide CloudWatch/OTEL implementation of `MonitoringService` using the same `ErrorEvent`/`MetricEvent` contracts.
- Disable `MockMonitoringService` via properties.
- Optionally switch logging to JSON encoder and forward to a collector.


