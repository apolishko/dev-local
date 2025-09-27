## Task 603: Server-side AMS Integration (RabbitMQ) — Implementation Plan

### Objective
- Enable server-side graph execution to load AMS (Asset Management System) resources in addition to existing generator resources.
- Route resource loading via a new `source` argument (`'generator' | 'ams'`) through the `Load Resource` operation end-to-end (compiler → nodes → operation impl → storage).
- Prepare for video use-cases required by the next ticket (ProRes vs MP4), including decoding in `Select Frame From Video` without hardcoded input format.

### Why (Business/Tech Value)
- Unlocks usage of centrally managed assets (AMS) in server-side runs and orders.
- Sets the foundation for video-specific needs (ProRes for order, closest-resolution MP4 for previews) without blocking on client-only flows.
- Preserves browser behavior (existing AMS optimization of images by URL) and keeps schema-first type safety.

### Scope (MVP for 603)
1) Add and propagate `source: 'generator' | 'ams'` through the `Load Resource` operation.
2) Update server/browser operation implementations to accept 3 args and route by `source`.
3) Extend platform storage types and validators to handle AMS references.
4) Implement server ResourceStorage AMS branch (minimal placeholder first, then RabbitMQ client).
5) Remove MP4-only constraint in `Select Frame From Video` to support ProRes MOV decoding.
6) Introduce RabbitMQ AMS client (request/response) and wire server AMS resource loading to it.

Out-of-scope (for later, if needed): full browser-side AMS video fetch; advanced caching; bulk workflows.

---

## Architecture Overview (Result State)
- SourceGraph parameter value can be either `{ resourceRef: string }` or `{ ams: string }` (already in `types/SourceGraph/Resource.ts`).
- Compiler injects a dedicated Load Resource node per resource parameter with args: `[resourceType, ref, source]`.
- Platform `Load Resource` operation signature updated to 3 arguments.
- Operation impl on server chooses the `ResourceStorage` path by `source`:
  - generator → existing blob path
  - ams → RabbitMQ client request → AMS worker → response with file URL → download → return Buffer (image/binary)
- Video decoding no longer hardcodes MP4 input, uses container info (from `services.videoData`) or automatic detection.

---

## File-by-File Changes

### 1) Propagate `source` in operation definition and node generation

- File: `src/platform/generic/data/operations/loadResource.ts`
  - Change operation args from 2 to 3.
  - New signature (type description, not code):
    - args: `['resource type': string, 'reference': string, 'source': 'generator' | 'ams']`
  - Outputs unchanged.

- File: `src/platform/generic/data/nodeClasses/processing/LoadResources/getLoadResourceNodeClass.ts`
  - Add a node parameter `source` (string) to each generated Load … resource node.
  - In `operationCall.args` add third arg mapping `{ source: 'parameter', name: 'source' }` after `resource type` and `ref`.
  - Resulting node has parameters: `ref` (string), `source` (string); outputs unchanged.

- File: `src/core/compiler/nodes/normalizeSourceGraphForCompiler/loadResourceParameterViaNode.ts`
  - Currently sets parameters to `{ name: 'ref', value: parameter.value.resourceRef }`.
  - Change logic:
    - If `parameter.value` is `{ resourceRef: string }` → create load node with `ref = resourceRef`, `source = 'generator'`.
    - If `parameter.value` is `{ ams: string }` → create load node with `ref = ams`, `source = 'ams'`.
  - Keep wiring (edge creation) unchanged.

### 2) Type predicates and platform storage types

- File: `src/platform/types/Services/ResourceStorage.ts`
  - Redefine `ResourceReference` from only `{ resourceRef: string }` to a union:
    - `type ResourceReference = { resourceRef: string } | { ams: string };`
  - Keep `GetResource` and `ResourceStorage` signatures using `ResourceReference` as-is.

- File: `src/types/InteroperationTypes/ValuePredicates.ts`
  - Update `isValidResourceReference(value)` to return `true` for either `{ resourceRef }` or `{ ams }`.
  - Add explicit guards:
    - `isValidGeneratorResourceReference(value): value is { resourceRef: string }`.
    - `isValidAMSResourceReference(value): value is { ams: string }`.

### 3) Operation implementations

- File: `src/graphics/server/operations/loadResource.ts`
  - Accept 3 args; validate types and `source` value.
  - Build `ResourceReference` based on `source`:
    - `'generator'` → `{ resourceRef: ref }`
    - `'ams'` → `{ ams: ref }`
  - Call `services.resourceStorage.get(resourceReference, { type: resourceType }, config.scalingFactor)`.
  - Error messages: include `source` for clarity if not found.

- File: `src/graphics/browser/operations/loadResource.ts`
  - Accept 3 args (ignore `source` for now). Existing browser `ViewerResourceStorage` resolves URL and optional AMS optimization already.
  - Keep `getAssetURLsImplementation` returning same preload requests (generator paths).

### 4) Server ResourceStorage with AMS branch and video rules

- File: `src/server/services/resources/storage.ts`
  - Import new guards from `types/InteroperationTypes/ValuePredicates`.
  - `get(resourceReference, type, scalingFactor)` changes:
    - Validate supported types as before.
    - If `isValidGeneratorResourceReference(resourceReference)` → existing logic (blob path) unchanged.
    - If `isValidAMSResourceReference(resourceReference)`:
      - For image: in MVP, call a placeholder `getAMSResourceViaRabbitMQ` (implemented below). If MQ not yet wired, return `null` (feature-flagged) instead of throwing.
      - For binary/video: select AMS variation according to video scenario (see below), then fetch and return the Buffer.
      - For image sequence: not yet supported → explicit error.
  - Add helper (skeleton first, filled in step 6):
    - `async function getAMSResourceViaRabbitMQ(ref, type, scalingFactor): Promise<Buffer | null>` → publish request, await response, fetch file URL, normalize (e.g., `ensureImageProperties` for images) and return Buffer.
  - Add variation selection helpers (used for video assets):
    - `selectProResOrFallbackMp4(assetMetadata): { url: string; mimeType: string }`
    - `selectClosestResolutionMp4(assetMetadata, scalingFactor?): { url: string; mimeType: string }`
    - NOTE: Selection rules tie to the next ticket:
      - Order (ProRes requested): pick ProRes MOV if available; else max-resolution MP4.
      - Server-side preview: pick closest-resolution MP4 (by height).
    - Use `services.videoData` if set (container preference, fps, desired resolution hints); otherwise compute by `scalingFactor`.

### 5) FFmpeg: remove MP4-only constraint in Select Frame From Video

- File: `src/graphics/server/operations/selectFrameFromVideo.ts`
  - Remove the hardcoded `.inputFormat('mp4')` from `runFfmpeg`.
  - Optionally, deduce container from `services.videoData?.container` and only set `.inputFormat()` when necessary/known. If unknown, let ffmpeg auto-detect.
  - Keep frame extraction filters/options unchanged.

### 6) RabbitMQ AMS client (server → AMS worker)

- New File: `src/server/services/ams/rabbitMQClient.ts`
  - Responsibilities: publish request messages to `ams.request`, consume replies from `ams.response.server`, correlate by `correlationId`/`requestId`, enforce timeout.
  - API (example):
    - `requestImageResource({ assetId, parameters: { scale|height }, resourceType, requestId }): Promise<{ success: boolean; fileUrl?: string; error?: string }>`
    - `requestBinaryResource({ assetId, desired: { container?: 'mp4'|'mov', height?: number }, requestId }): Promise<...>`
  - Use existing RabbitMQ connection utilities (same pattern as ComfyUI/Omniverse gateways) for channel management.

- New File: `src/server/mq/queues/ams.ts`
  - Export queue names: `REQUEST = 'ams.request'`, `RESPONSE = 'ams.response.server'`, `STATUS = 'ams.status'`.

- New File: `src/server/mq/listeners/ams.ts`
  - A lightweight response-listener abstraction that maps `requestId` → promise resolution.
  - Used internally by `rabbitMQClient.ts` or by `storage.ts` for waiting on a response.

### 7) Configuration

- File: `src/server/configuration/environment.ts`
  - Add `ams` config section:
    - `enabled: boolean`
    - `requestQueue: string`
    - `responseQueue: string`
    - `timeout: number`
    - `fallbackEnabled: boolean`
  - Thread through defaults from `config/*.json`.

- File: `config/default.json`
  - Add `ams` defaults (safe values), e.g.:
    - `"ams": { "enabled": "false", "requestQueue": "ams.request", "responseQueue": "ams.response.server", "timeout": "30000", "fallbackEnabled": "true" }`

- File: `docker-compose.yml`
  - Optionally add `AMS_ENABLED`, `AMS_REQUEST_QUEUE`, `AMS_RESPONSE_QUEUE`, `AMS_TIMEOUT_MS`, `AMS_FALLBACK_ENABLED` envs for the `server` service.

### 8) Tests

- New/Update Unit tests:
  - `src/graphics/server/operations/__tests__/loadResource.test.ts`
    - 3-arg handling; `'generator'` routes to `{ resourceRef }` path; `'ams'` routes to AMS path (mocked MQ client).
  - `src/server/services/resources/__tests__/storage.ams.test.ts`
    - AMS image path (mock MQ returns URL → fetch → buffer → ensureImageProperties), AMS video path (selection helpers called; returned buffer is non-empty).
  - `src/graphics/server/operations/__tests__/selectFrameFromVideo.test.ts`
    - Remove MP4-only assumption; ensure ProRes/MOV buffer decodes when ffmpeg available (can be guarded or mocked).

- Update integration tests (where feasible) to cover AMS happy-path via mocked MQ responses.

### 9) Migration & Compatibility
- Backward compatible: existing graphs using `{ resourceRef }` continue to work; new `source` argument defaults correctly via compiler injection.
- Browser flows unchanged; AMS optimization by URL remains as-is.
- If MQ not configured (`ams.enabled=false`), AMS branch returns `null` and higher-level logic should fail gracefully or fallback per config.

### 10) Acceptance Criteria
- `Load Resource` accepts 3 args across platform/browser/server, compiles and runs.
- Server can execute graphs with AMS resources (image/binary) when AMS queues are available:
  - Images: loaded via MQ, returned as normalized PNG buffer with alpha ensured.
  - Videos: for order with ProRes requested → MOV when available else max MP4; for preview → closest-resolution MP4.
- `Select Frame From Video` works with MP4 and ProRes/MOV buffers.
- Tests added/updated; type checks pass.

### 11) Rollback Plan
- Revert the changes to operation signatures and compiler node generation if required.
- Keep RabbitMQ client files isolated; safe to remove without disrupting generator resource path.

---

## Implementation Checklist (Chronological)
1) Update operation definition and node generation to pass `source`.
2) Update validators and platform types for `ResourceReference` union.
3) Update browser/server `loadResource` implementations to accept 3 args.
4) Adjust `storage.ts` routing (generator vs AMS) and add placeholders.
5) Remove `.inputFormat('mp4')` in `selectFrameFromVideo.ts`; use `videoData?.container` if available.
6) Implement RabbitMQ AMS client and wire the AMS branch in `storage.ts`.
7) Add tests; ensure build and test suite are green.

---

## Notes on AMS Schemas & Next Ticket Readiness
- The included AMS schemas (image, video/mp4, etc.) imply standardized variation IDs and properties (e.g., heights 1080/720/480, `previewImage`). Our selection helpers must map to these IDs by resolution and container.
- This plan unblocks the follow-up ticket:
  - ProRes (order): resolved in AMS branch selection helper and decoded by ffmpeg post-`inputFormat` removal.
  - Server preview (closest MP4): resolved by selection helper using scaling factor and/or `videoData`.
  - Browser preview (closest MP4): can remain a future enhancement (fetch by URL) without blocking server features.



