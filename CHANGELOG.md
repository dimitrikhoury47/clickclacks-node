# Changelog

This project follows [Semantic Versioning](https://semver.org/). Within the v1 API, the
server only makes additive changes, and so does this SDK within a major version.

## 1.1.0 — unreleased

Groups: companies, workspaces and teams.

- `group({ groupType, groupId, properties? })` now queues a `group` item instead of
  throwing. It records the group's traits (the newest call replaces the whole set). It
  also takes `timestamp` and `insertId`, and `groupId` may be a number (sent as a
  string). Bad input goes to `onError` as `invalid_call`, like `track` and `identify`.
- `track()` takes a typed `groups` option (`{ company: 'cmp_311' }`, at most 5 entries),
  written into `properties.$groups`. `$groups` in `properties` still works; the option
  wins when both are sent.
- New `onWarning` option (default `console.warn`) receives the API's additive
  `warnings[]`, such as `group_trait_dropped`, with each item's `insert_id`. New
  `ItemWarning` type.
- `NotYetSupportedError` stays exported for `alias`; no method throws it now.

## 1.0.1 — 2026-09-27

- Documentation links point at https://clickclacks.io/docs/api.

## 1.0.0 — 2026-09-26

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
