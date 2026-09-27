/**
 * Fixture parity: replays the API's request and response shapes through the client.
 *
 * `test/fixtures/spec/` holds the examples transcribed from the approved spec. When the
 * API lane publishes `docs/api/v1/fixtures/*.json` in the ClickClacks repo, run
 * `npm run fixtures:sync` to copy them into `test/fixtures/server/`; every file there is
 * replayed by the same rules. A fixture is `{ name, request?, response? }` (one pair) or a
 * catalogue `{ errors: [{ status, code, retry }] }`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClickClacks, GroupParams, IdentifyParams, TrackParams } from '../src/index.js'
import { VERSION } from '../src/index.js'
import { makeClient, mockApi } from './helpers.js'

interface WireItem {
  type?: string
  event?: string
  group_type?: string
  group_id?: string
  distinct_id?: string
  anonymous_id?: string
  session_id?: string
  timestamp?: string | number
  insert_id?: string
  properties?: Record<string, unknown>
}

interface PairFixture {
  name: string
  request?: {
    method?: string
    path?: string
    query?: Record<string, string>
    headers?: Record<string, string>
    body?: { items: WireItem[] }
  }
  response?: { status: number; headers?: Record<string, string>; body?: unknown }
}

interface CatalogueFixture {
  errors: { status: number; code: string; retry: 'yes' | 'no' | 'split'; retry_after?: string; item_errors?: boolean }[]
  item_codes?: string[]
}

type Fixture = { file: string } & (PairFixture | CatalogueFixture)

function loadFixtures(): Fixture[] {
  const dirs = ['spec', 'server'].map((d) => join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', d))
  return dirs
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) })),
    )
}

const fixtures = loadFixtures()
const pairs = fixtures.filter((f): f is Fixture & PairFixture => 'response' in f || 'request' in f)
const catalogues = fixtures.filter((f): f is Fixture & CatalogueFixture => 'errors' in f && Array.isArray(f.errors))

/** Turns a wire item back into the SDK call that should produce it. */
function replay(client: ClickClacks, item: WireItem): void {
  if (item.type === 'group') {
    const params: GroupParams = { groupType: item.group_type as string, groupId: item.group_id as string }
    if (item.timestamp !== undefined) params.timestamp = item.timestamp
    if (item.insert_id !== undefined) params.insertId = item.insert_id
    if (item.properties !== undefined) params.properties = item.properties
    client.group(params)
    return
  }
  if (item.type === 'identify') {
    const params: IdentifyParams = { distinctId: item.distinct_id as string }
    if (item.anonymous_id !== undefined) params.anonymousId = item.anonymous_id
    if (item.timestamp !== undefined) params.timestamp = item.timestamp
    if (item.insert_id !== undefined) params.insertId = item.insert_id
    if (item.properties !== undefined) params.properties = item.properties
    client.identify(params)
    return
  }
  const params: TrackParams = { event: item.event as string }
  if (item.distinct_id !== undefined) params.distinctId = item.distinct_id
  if (item.anonymous_id !== undefined) params.anonymousId = item.anonymous_id
  if (item.session_id !== undefined) params.sessionId = item.session_id
  if (item.timestamp !== undefined) params.timestamp = item.timestamp
  if (item.insert_id !== undefined) params.insertId = item.insert_id
  if (item.properties !== undefined) params.properties = item.properties
  client.track(params)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('has fixtures to replay', () => {
  expect(pairs.length).toBeGreaterThan(0)
  expect(catalogues.length).toBeGreaterThan(0)
})

describe.each(pairs.filter((f) => f.request?.body).map((f) => [f.name, f] as const))('request %s', (_name, fixture) => {
  it('is what the SDK sends for the same calls', async () => {
    const api = mockApi()
    const { client, errors } = makeClient({ fetch: api.fetch })
    const expected = fixture.request?.body?.items ?? []
    for (const item of expected) replay(client, item)
    await client.flush()
    expect(errors).toEqual([])
    expect(api.requests).toHaveLength(1)
    const [request] = api.requests
    expect(new URL(request?.url ?? '').pathname).toBe(fixture.request?.path ?? '/api/v1/batch')
    expect(fixture.request?.method ?? 'POST').toBe('POST')
    expect(request?.headers.Authorization).toMatch(/^Bearer (cks_live_|sk_live_)/)
    expect(request?.headers['Content-Type']).toBe(fixture.request?.headers?.['Content-Type'] ?? 'application/json')
    expect(request?.headers['User-Agent']).toBe(`clickclacks-node/${VERSION}`)
    if (fixture.request?.headers?.['User-Agent']) {
      expect(fixture.request.headers['User-Agent']).toMatch(/^clickclacks-node\/\d+\.\d+\.\d+$/)
    }

    const sent = request?.json.items ?? []
    expect(sent).toHaveLength(expected.length)
    sent.forEach((item, i) => {
      const fixtureItem = expected[i] as WireItem
      // Every field the fixture shows is sent exactly as shown...
      expect(item).toMatchObject(fixtureItem as Record<string, unknown>)
      // ...and the only extras are ones the SDK always adds.
      const extras = Object.keys(item).filter((key) => !(key in fixtureItem))
      for (const key of extras) expect(['type', 'timestamp', 'insert_id']).toContain(key)
      expect(item.type ?? 'track').toBe(fixtureItem.type ?? 'track')
      expect(item.insert_id).toMatch(/^[A-Za-z0-9_-]{1,80}$/)
    })
  })
})

describe.each(pairs.filter((f) => f.response).map((f) => [f.name, f] as const))('response %s', (_name, fixture) => {
  it('is handled by the documented rule', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const response = fixture.response as NonNullable<PairFixture['response']>
    const api = mockApi((_req, n) =>
      n === 0 ? { status: response.status, headers: response.headers, body: response.body } : { status: 202, body: {} },
    )
    const { client, errors } = makeClient({ fetch: api.fetch })
    // Enough items for any index the fixture mentions.
    const body = (response.body ?? {}) as { errors?: { index: number; code: string }[] }
    const count = Math.max(1, ...(body.errors ?? []).map((e) => e.index + 1))
    for (let i = 0; i < count; i++) client.track({ event: `e${i}`, distinctId: 'u', insertId: `ins_${i}` })
    const done = client.flush()
    await vi.advanceTimersByTimeAsync(301_000)
    await done

    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    expect(api.requests).toHaveLength(retryable ? 2 : 1)
    if (retryable && response.headers?.['Retry-After']) {
      const waited = (api.requests[1]?.at ?? 0) - (api.requests[0]?.at ?? 0)
      expect(waited).toBe(Number(response.headers['Retry-After']) * 1000)
    }
    const itemErrors = body.errors ?? []
    if (itemErrors.length > 0) {
      expect(errors).toHaveLength(1)
      expect(errors[0]?.code).toBe('item_errors')
      expect(errors[0]?.itemErrors?.map((e) => [e.index, e.code, e.insertId])).toEqual(
        itemErrors.map((e) => [e.index, e.code, `ins_${e.index}`]),
      )
    } else if (response.status < 300 || retryable) {
      expect(errors).toEqual([])
    }
  })
})

describe.each(catalogues.flatMap((c) => c.errors.map((e) => [`${e.status} ${e.code}`, e] as const)))(
  'error %s',
  (_name, entry) => {
    it('gets the retry behaviour the catalogue documents', async () => {
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const errorBody = {
        error: { code: entry.code, message: `${entry.code} message`, docs_url: 'https://…', request_id: 'ray' },
        ...(entry.item_errors ? { errors: [{ index: 0, code: 'missing_event_name', field: 'event' }] } : {}),
      }
      const failing = {
        status: entry.status,
        body: errorBody,
        headers: (entry.retry_after ? { 'Retry-After': entry.retry_after } : {}) as Record<string, string>,
      }
      // A 413 is answered for any batch of more than one item, so the split halves go through.
      const api = mockApi((req, n) =>
        (entry.retry === 'split' ? req.json.items.length > 1 : n === 0) ? failing : { status: 202, body: {} },
      )
      const { client, errors } = makeClient({ fetch: api.fetch })
      const items = entry.retry === 'split' ? 2 : 1
      for (let i = 0; i < items; i++) client.track({ event: `e${i}`, distinctId: 'u' })
      const done = client.flush()
      await vi.advanceTimersByTimeAsync(301_000)
      await done

      if (entry.retry === 'yes') {
        expect(api.requests).toHaveLength(2)
        expect(errors).toEqual([])
        if (entry.retry_after) {
          expect((api.requests[1]?.at ?? 0) - (api.requests[0]?.at ?? 0)).toBe(Number(entry.retry_after) * 1000)
        }
      } else if (entry.retry === 'split') {
        expect(api.requests.map((r) => r.json.items.length)).toEqual([2, 1, 1])
        expect(errors).toEqual([])
      } else {
        expect(api.requests).toHaveLength(1)
        expect(errors).toHaveLength(1)
        if (entry.item_errors) {
          expect(errors[0]).toMatchObject({ code: 'item_errors', apiCode: entry.code, status: entry.status })
        } else {
          expect(errors[0]).toMatchObject({
            code: 'request_rejected',
            apiCode: entry.code,
            status: entry.status,
            requestId: 'ray',
          })
        }
      }
    })
  },
)

it('a 413 for a single item is reported, not retried', async () => {
  const api = mockApi([{ status: 413, body: { error: { code: 'payload_too_large' } } }])
  const { client, errors } = makeClient({ fetch: api.fetch })
  client.track({ event: 'x', distinctId: 'u' })
  await client.flush()
  expect(api.requests).toHaveLength(1)
  expect(errors[0]).toMatchObject({ code: 'request_rejected', apiCode: 'payload_too_large' })
})
