### Open Issues / Follow-ups

* AMS support in ResourceStorage is limited to the main get flow; getRaw, mapToURLs, and url still throw, and the fallback hook is a stub (src/server/services/resources/storage.ts:169, :176).
* Browser-side loadResource continues to build generator-style references even when source === 'ams', so front-end usage will need extra plumbing (src/graphics/browser/operations/loadResource.ts:40).
* Config flags such as preferProResForOrders and mp4FallbackForOrders are only partially exercised; order-mode handling isn’t wired through ResourceStorage yet (config/default.json:150).
* The new 3-argument contract breaks old graphs that still emit two arguments; callers must be migrated (test/server/integration/ams.test.ts:138).
