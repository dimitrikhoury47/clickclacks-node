# @clickclacks/node

Send events to [ClickClacks](https://clickclacks.io) from your servers: "Subscription
started", "Invoice paid", "Export finished". Server events can't be faked by a visitor,
don't depend on ad blockers, and don't need a browser open.

- Batches, gzips and retries safely. Every event carries an `insert_id`, so a retry never
  double counts.
- Works on Node 18+ and Cloudflare Workers.
- Zero runtime dependencies. ESM, CommonJS and TypeScript types.

```sh
npm install @clickclacks/node
```

## Quick start

Create a server key in ClickClacks under **Settings › API keys › Server keys** (it starts
with `cks_live_` and is shown once). Keep it in an environment variable and never ship it
to a browser; the API refuses browser requests.

```ts
import { ClickClacks } from '@clickclacks/node'

const clickclacks = new ClickClacks({ key: process.env.CLICKCLACKS_SERVER_KEY! })

clickclacks.track({
  event: 'Subscription started',
  distinctId: 'user_8412',
  properties: { plan: 'pro', $revenue: 49, $currency: 'USD' },
})

clickclacks.identify({
  distinctId: 'user_8412',
  anonymousId: 'per_k3J9sQ1xR2', // optional: the browser key, to join the browser's history
  properties: { plan: 'pro' },
})

// Before the process exits:
process.on('SIGTERM', async () => {
  await clickclacks.shutdown()
  process.exit(0)
})
```

`track` and `identify` return immediately; events are sent in the background. The
automatic flush timer doesn't keep a Node process alive, so call `shutdown()` (or
`await flush()`) before a script or job ends.

## Cloudflare Workers

Workers can't keep timers between requests. Turn the timer off and flush at the end of
each request with `flushWith(ctx)`, which is `ctx.waitUntil(clickclacks.flush())`:

```ts
import { ClickClacks } from '@clickclacks/node'

let clickclacks: ClickClacks | undefined

export default {
  async fetch(request, env, ctx) {
    clickclacks ??= new ClickClacks({ key: env.CLICKCLACKS_SERVER_KEY, flushInterval: 0 })
    clickclacks.track({ event: 'Export finished', distinctId: 'user_8412' })
    clickclacks.flushWith(ctx)
    return new Response('ok')
  },
} satisfies ExportedHandler<{ CLICKCLACKS_SERVER_KEY: string }>
```

No `nodejs_compat` flag is needed. Bun and Deno work too, but aren't promised.

## API

### `new ClickClacks(options)`

| Option | Default | |
|---|---|---|
| `key` | required | A secret server key, `cks_live_…` (legacy `sk_live_…` Source keys also work). A public `pk_live_` key throws. |
| `host` | `https://app.clickclacks.io` | Custom domains don't serve the server API. |
| `flushAt` | `100` | Items per batch, 1–500. Reaching it sends at once. |
| `flushInterval` | `5000` | Milliseconds between automatic flushes. `0` turns the timer off (edge mode). |
| `maxQueueSize` | `10000` | Items held in memory, queued or in flight. |
| `maxRetries` | `6` | Retries after the first attempt. |
| `requestTimeout` | `10000` | Milliseconds before a request is abandoned and retried. |
| `onError` | `console.warn` | Receives a `ClickClacksError` (see below). |
| `fetch` | global `fetch` | Replace it for proxies or tests. |

### `track({ event, distinctId?, anonymousId?, sessionId?, timestamp?, insertId?, properties? })`

Queues an event. One of `distinctId` (your user ID) or `anonymousId` (a `per_…` browser
key) is required. `timestamp` is a `Date`, an ISO 8601 string or epoch milliseconds, and
defaults to the moment you call `track`. `insertId` is generated when omitted.

Event names starting with `$` are reserved. In `properties` you may send `$ip`,
`$user_agent`, `$country`, `$current_url`, `$groups`, `$revenue` and `$currency`; other
`$` keys are refused by the API.

### `identify({ distinctId, anonymousId?, timestamp?, insertId?, properties? })`

Records traits for a user, and links `anonymousId` (if given) to them, exactly like the
browser tracker's `identify`. `identify` calls are free.

### `flush(): Promise<void>`

Sends everything queued now and resolves when it's delivered, refused or given up on.
It never rejects; problems go to `onError`.

### `flushWith(ctx): Promise<void>`

`ctx.waitUntil(clickclacks.flush())`, for Workers and other edge runtimes.

### `shutdown({ timeout = 10000 } = {}): Promise<void>`

Flushes, stops the timer and refuses new calls. After `timeout` ms it stops retrying and
reports what's left as `shutdown_timeout`. Safe to call twice.

### `group(...)`: reserved

Coming with Groups. It throws `NotYetSupportedError` today. Until then, send group
membership on events: `properties: { $groups: { company: 'cmp_311' } }`.

### Errors

`onError` receives a `ClickClacksError` with a `code`:

| `code` | Meaning |
|---|---|
| `item_errors` | The API refused some items. `itemErrors` lists `{ index, code, field, message, insertId, event }`. Never retried. |
| `request_rejected` | The API refused the whole request (for example `invalid_key`). `apiCode` and `status` say why. Never retried. |
| `request_failed` | Every retry failed; `count` items were lost. |
| `queue_full` | `maxQueueSize` was reached and a new item was dropped. `dropped` is the running count. |
| `shutdown_timeout` | `shutdown()` hit its deadline; `count` items weren't delivered. |
| `invalid_call` | A `track`/`identify` call was malformed; nothing was queued. |
| `item_too_large` | One item serialised to more than 1 MiB. |
| `client_closed` | A call arrived after `shutdown()`. |

The key never appears in an error or a log line.

## How delivery works

- **Batching:** a batch is sent when the queue reaches `flushAt` or after
  `flushInterval`, split so each request stays under the API's 1 MiB cap. Batches are
  sent one at a time, in order.
- **Compression:** bodies over 1 KiB are gzipped with the built-in `CompressionStream`.
- **Idempotency:** every item gets an `insert_id` (`crypto.randomUUID()` without dashes)
  when it's queued, and a retry resends the same bytes. The API drops repeats within a
  Source, so retrying is always safe.
- **Retries:** network errors, timeouts, `408`, `429` and `5xx` are retried with
  exponential backoff (500 ms × 2ⁿ, capped at 30 s) and full jitter. A server
  `Retry-After` always wins, up to 5 minutes. Other `4xx` responses are never retried. A
  `413` splits the batch in half and resends.
- **Queue cap:** when `maxQueueSize` is reached, *new* items are dropped, so an outage
  loses the tail rather than events already queued.

Rate limits are 1,000 events/s sustained and 5,000 events/s burst per project, and 100
requests/s per key. They are approximate and counted per Cloudflare location. A `429`
means nothing in that request was stored, so the retry is safe.

## Privacy

- Use an opaque internal user ID as `distinctId`, not an email address. Put email and
  name only in `identify` traits, if you need them.
- Never put secrets in properties.
- `$ip` is kept only when the Source records IP addresses; `$user_agent` is used for
  browser/OS/device and bot filtering, then dropped.

## Other languages (raw HTTP)

There's one endpoint, `POST https://app.clickclacks.io/api/v1/batch`, with
`Authorization: Bearer <server key>` and a JSON body `{ "items": [...] }` of up to 500
items. Always send an `insert_id`, and reuse it when you retry, so a retry never double
counts. Retry on `429` and `5xx`, honouring `Retry-After`.

### curl

```sh
curl https://app.clickclacks.io/api/v1/batch \
  -H "Authorization: Bearer $CLICKCLACKS_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"event":"Invoice paid","distinct_id":"user_8412","insert_id":"inv_2291","properties":{"amount_cents":4900}}]}'
```

### Python

```python
import os, uuid, requests
requests.post(
    "https://app.clickclacks.io/api/v1/batch",
    headers={"Authorization": f"Bearer {os.environ['CLICKCLACKS_SERVER_KEY']}"},
    json={"items": [{"event": "Invoice paid", "distinct_id": "user_8412",
                     "insert_id": uuid.uuid4().hex, "properties": {"amount_cents": 4900}}]},
    timeout=10,
).raise_for_status()
```

With retries (the body, and so every `insert_id`, is built once):

```python
import os, random, time, uuid, requests

def send(items, attempts=6):
    body = {"items": items}  # each item already has its insert_id
    for attempt in range(attempts + 1):
        try:
            resp = requests.post(
                "https://app.clickclacks.io/api/v1/batch",
                headers={"Authorization": f"Bearer {os.environ['CLICKCLACKS_SERVER_KEY']}"},
                json=body, timeout=10,
            )
        except requests.RequestException:
            resp = None
        if resp is not None and resp.status_code < 500 and resp.status_code not in (408, 429):
            resp.raise_for_status()   # other 4xx: fix the request, don't retry
            return resp.json()        # 202: check resp.json()["errors"] for refused items
        if attempt == attempts:
            raise RuntimeError("ClickClacks: gave up after retries")
        retry_after = resp.headers.get("Retry-After") if resp is not None else None
        delay = float(retry_after) if retry_after else random.uniform(0, min(30, 0.5 * 2 ** attempt))
        time.sleep(min(delay, 300))

send([{"event": "Invoice paid", "distinct_id": "user_8412",
       "insert_id": uuid.uuid4().hex, "properties": {"amount_cents": 4900}}])
```

### Go

```go
body, _ := json.Marshal(map[string]any{"items": []map[string]any{{
    "event": "Invoice paid", "distinct_id": "user_8412",
    "insert_id": uuid.NewString(), "properties": map[string]any{"amount_cents": 4900},
}}})
req, _ := http.NewRequest("POST", "https://app.clickclacks.io/api/v1/batch", bytes.NewReader(body))
req.Header.Set("Authorization", "Bearer "+os.Getenv("CLICKCLACKS_SERVER_KEY"))
req.Header.Set("Content-Type", "application/json")
resp, err := http.DefaultClient.Do(req) // retry on 429/5xx, honouring Retry-After
```

With retries (the same `body`, and so the same `insert_id`s, on every attempt):

```go
func send(body []byte) error {
	client := &http.Client{Timeout: 10 * time.Second}
	for attempt := 0; ; attempt++ {
		req, _ := http.NewRequest("POST", "https://app.clickclacks.io/api/v1/batch", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+os.Getenv("CLICKCLACKS_SERVER_KEY"))
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		retry := err != nil
		var wait time.Duration
		if err == nil {
			resp.Body.Close() // for a 202, decode it first and check "errors"
			switch {
			case resp.StatusCode < 300:
				return nil
			case resp.StatusCode == 408 || resp.StatusCode == 429 || resp.StatusCode >= 500:
				retry = true
				if s, e := strconv.Atoi(resp.Header.Get("Retry-After")); e == nil {
					wait = time.Duration(s) * time.Second
				}
			default:
				return fmt.Errorf("clickclacks: HTTP %d, not retrying", resp.StatusCode)
			}
		}
		if !retry || attempt == 6 {
			return fmt.Errorf("clickclacks: gave up after %d attempts", attempt+1)
		}
		if wait == 0 {
			ceiling := math.Min(30, 0.5*math.Pow(2, float64(attempt)))
			wait = time.Duration(rand.Float64() * ceiling * float64(time.Second))
		}
		time.Sleep(min(wait, 5*time.Minute))
	}
}
```

The full reference, including every error code, is at
[clickclacks.io/docs/api](https://clickclacks.io/docs/api).

## Development

```sh
npm install
npm run lint && npm run typecheck && npm test
npm run build && npm run test:package   # ESM and CJS entry points
npm run test:workerd                     # a smoke test inside workerd, through Miniflare
npm run fixtures:sync -- ../clickclacks  # copy the API's contract fixtures into test/fixtures/server
```

`test/contract.test.ts` replays the API's request and response fixtures through the
client. Until the API publishes `docs/api/v1/fixtures/`, it replays the examples
transcribed from the API spec in `test/fixtures/spec/`.

## Licence

MIT
