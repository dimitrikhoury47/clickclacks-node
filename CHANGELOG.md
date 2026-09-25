# Changelog

This project follows [Semantic Versioning](https://semver.org/). Within the v1 API, the
server only makes additive changes, and so does this SDK within a major version.

## 1.0.0 — unreleased

First release, for `POST /api/v1/batch`.

- `track` and `identify`, queued and sent in batches of `flushAt` (default 100, at most
  500) or every `flushInterval` (default 5 s).
- Every item gets an `insert_id` when it's queued, so retries never double count.
- Bodies over 1 KiB are gzipped; each request stays under the API's 1 MiB cap.
- Retries on network errors, timeouts, `408`, `429` and `5xx`: exponential backoff
  (500 ms × 2ⁿ, capped at 30 s) with full jitter, and a server `Retry-After` always wins
  (up to 5 minutes). Other `4xx` responses are never retried. A `413` splits the batch.
- Per-item errors from a `202` go to `onError` with the item's `insert_id`; they are never
  retried.
- `maxQueueSize` (default 10,000) caps memory; when full, new items are dropped and
  reported as `queue_full`.
- `shutdown()` flushes with a deadline (default 10 s) and then refuses new calls.
- Edge mode for Cloudflare Workers: `flushInterval: 0` and `flushWith(ctx)`.
- `group()` is reserved and throws `NotYetSupportedError` until the API supports Groups.
- Zero runtime dependencies. ESM, CommonJS and TypeScript types. Node 18+ and Workers.
