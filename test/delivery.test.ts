import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_BODY_BYTES } from '../src/index.js'
import { accepted, makeClient, mockApi } from './helpers.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('batching', () => {
  it('sends as soon as the queue reaches flushAt', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch, flushAt: 3 })
    client.track({ event: 'a', distinctId: 'u' })
    client.track({ event: 'b', distinctId: 'u' })
    await tick()
    expect(api.requests).toHaveLength(0)
    client.track({ event: 'c', distinctId: 'u' })
    await client.flush()
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]?.json.items.map((i) => i.event)).toEqual(['a', 'b', 'c'])
  })

  it('sends after flushInterval', async () => {
    vi.useFakeTimers()
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch, flushAt: 100, flushInterval: 5000 })
    client.track({ event: 'a', distinctId: 'u' })
    await vi.advanceTimersByTimeAsync(4999)
    expect(api.requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.requests).toHaveLength(1)
    // The timer is re-armed by the next item, not left running.
    expect(vi.getTimerCount()).toBe(0)
    client.track({ event: 'b', distinctId: 'u' })
    expect(vi.getTimerCount()).toBe(1)
  })

  it('splits a large flush into batches of flushAt, in order', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch, flushAt: 100, maxQueueSize: 1000 })
    for (let i = 0; i < 250; i++) client.identify({ distinctId: `u${i}` })
    await client.flush()
    expect(api.requests.map((r) => r.json.items.length)).toEqual([100, 100, 50])
    const ids = api.requests.flatMap((r) => r.json.items.map((i) => i.distinct_id))
    expect(ids).toEqual(Array.from({ length: 250 }, (_, i) => `u${i}`))
  })

  it('keeps every request body under 1 MiB uncompressed', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch, flushAt: 500 })
    const blob = 'x'.repeat(300_000)
    for (let i = 0; i < 7; i++) client.track({ event: 'big', distinctId: 'u', properties: { blob } })
    await client.flush()
    expect(api.requests.length).toBeGreaterThan(1)
    for (const request of api.requests) {
      expect(Buffer.byteLength(JSON.stringify(request.json))).toBeLessThanOrEqual(MAX_BODY_BYTES)
    }
    expect(api.requests.reduce((n, r) => n + r.json.items.length, 0)).toBe(7)
  })

  it('serialises flushes so batches never overlap', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const base = mockApi()
    const fetch: typeof base.fetch = async (url, init) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick()
      inFlight--
      return base.fetch(url, init)
    }
    const { client } = makeClient({ fetch, flushAt: 2 })
    for (let i = 0; i < 10; i++) client.track({ event: `e${i}`, distinctId: 'u' })
    await client.flush()
    expect(maxInFlight).toBe(1)
    expect(base.requests.flatMap((r) => r.json.items.map((i) => i.event))).toEqual(
      Array.from({ length: 10 }, (_, i) => `e${i}`),
    )
  })
})

describe('gzip', () => {
  it('gzips bodies over 1 KiB and the payload round-trips', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch })
    client.track({ event: 'big', distinctId: 'u', properties: { text: 'hello '.repeat(400) } })
    await client.flush()
    const request = api.requests[0]!
    expect(request.headers['Content-Encoding']).toBe('gzip')
    expect(request.raw).toBeInstanceOf(Uint8Array)
    const decoded = JSON.parse(gunzipSync(request.raw as Uint8Array).toString('utf8'))
    expect(decoded.items[0].properties.text).toBe('hello '.repeat(400))
    expect((request.raw as Uint8Array).length).toBeLessThan(1024)
  })

  it('sends small bodies as plain JSON', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch })
    client.track({ event: 'small', distinctId: 'u' })
    await client.flush()
    expect(api.requests[0]?.headers['Content-Encoding']).toBeUndefined()
    expect(typeof api.requests[0]?.raw).toBe('string')
  })

  it('falls back to plain JSON when CompressionStream is missing', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    try {
      const api = mockApi()
      const { client } = makeClient({ fetch: api.fetch })
      client.track({ event: 'big', distinctId: 'u', properties: { text: 'x'.repeat(5000) } })
      await client.flush()
      expect(api.requests[0]?.headers['Content-Encoding']).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('retries', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries HTTP %i', async (status) => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const api = mockApi([{ status, body: { error: { code: 'x' } } }, accepted(1)])
    const { client, errors } = makeClient({ fetch: api.fetch })
    client.track({ event: 'a', distinctId: 'u' })
    const done = client.flush()
    await vi.advanceTimersByTimeAsync(30_000)
    await done
    expect(api.requests).toHaveLength(2)
    expect(errors).toEqual([])
  })

  it.each([400, 401, 403, 404, 405, 410, 415])('never retries HTTP %i', async (status) => {
    vi.useFakeTimers()
    const api = mockApi([{ status, body: { error: { code: 'nope', message: 'Refused', request_id: 'r1' } } }])
    const { client, errors } = makeClient({ fetch: api.fetch })
    client.track({ event: 'a', distinctId: 'u' })
    client.track({ event: 'b', distinctId: 'u' })
    await client.flush()
    expect(api.requests).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'request_rejected', status, apiCode: 'nope', count: 2, requestId: 'r1' })
  })

  it('retries network errors and timeouts', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const api = mockApi([new TypeError('fetch failed'), 'hang', accepted(1)])
    const { client, errors } = makeClient({ fetch: api.fetch, requestTimeout: 2000 })
    client.track({ event: 'a', distinctId: 'u' })
    const done = client.flush()
    await vi.advanceTimersByTimeAsync(2000)
    await done
    expect(api.requests).toHaveLength(3)
    expect(errors).toEqual([])
  })

  it('backs off 500 ms × 2ⁿ with full jitter, capped at 30 s', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.999999)
    const api = mockApi(() => ({ status: 500 }))
    const { client, errors } = makeClient({ fetch: api.fetch, maxRetries: 8 })
    const start = Date.now()
    client.track({ event: 'a', distinctId: 'u' })
    const done = client.flush()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await done
    const gaps = api.requests.slice(1).map((r, i) => r.at - (api.requests[i]?.at ?? start))
    // Math.random ≈ 1 gives the ceiling of each window, less one ms of flooring.
    expect(gaps).toEqual([499, 999, 1999, 3999, 7999, 15_999, 29_999, 29_999])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'request_failed', status: 500, count: 1 })
    expect(errors[0]?.message).toContain('9 attempts')
  })

  it('draws jitter from the whole window', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const api = mockApi([{ status: 500 }, { status: 500 }, accepted(1)])
    const { client } = makeClient({ fetch: api.fetch })
    client.track({ event: 'a', distinctId: 'u' })
    const done = client.flush()
    await vi.advanceTimersByTimeAsync(0)
    await done
    expect(api.requests).toHaveLength(3)
    expect(api.requests[2]?.at).toBe(api.requests[0]?.at)
  })

  it('waits exactly Retry-After seconds, which beats backoff', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const api = mockApi([
      { status: 429, headers: { 'Retry-After': '10' }, body: { error: { code: 'rate_limited' } } },
      accepted(1),
    ])
    const { client } = makeClient({ fetch: api.fetch })
    client.track({ event: 'a', distinctId: 'u' })
    const done = client.flush()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(api.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(api.requests).toHaveLength(2)
  })

  it('caps Retry-After at 5 minutes', async () => {
    vi.useFakeTimers()
    const api = mockApi([{ status: 503, headers: { 'Retry-After': '86400' } }, accepted(1)])
    const { client } = makeClient({ fetch: api.fetch })
    client.track({ event: 'a', distinctId: 'u' })
    const done = client.flush()
    await vi.advanceTimersByTimeAsync(299_999)
    expect(api.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(api.requests).toHaveLength(2)
  })

  it('gives up after maxRetries and reports the lost items with the API code', async () => {
    vi.useFakeTimers()
    const api = mockApi(() => ({
      status: 503,
      headers: { 'Retry-After': '5' },
      body: { error: { code: 'collection_unavailable', request_id: 'ray-1' } },
    }))
    const { client, errors } = makeClient({ fetch: api.fetch, maxRetries: 2 })
    client.track({ event: 'a', distinctId: 'u' })
    client.track({ event: 'b', distinctId: 'u' })
    const done = client.flush()
    await vi.advanceTimersByTimeAsync(10_000)
    await done
    expect(api.requests).toHaveLength(3)
    expect(errors[0]).toMatchObject({
      code: 'request_failed',
      count: 2,
      status: 503,
      apiCode: 'collection_unavailable',
      requestId: 'ray-1',
    })
    expect(client.pending).toBe(0)
  })

  it('splits and resends on 413', async () => {
    const api = mockApi((request) =>
      request.json.items.length > 2 ? { status: 413, body: { error: { code: 'payload_too_large' } } } : accepted(2),
    )
    const { client, errors } = makeClient({ fetch: api.fetch })
    for (let i = 0; i < 5; i++) client.track({ event: `e${i}`, distinctId: 'u' })
    await client.flush()
    const delivered = api.requests
      .filter((r) => r.json.items.length <= 2)
      .flatMap((r) => r.json.items.map((i) => i.event))
    expect(delivered).toEqual(['e0', 'e1', 'e2', 'e3', 'e4'])
    expect(errors).toEqual([])
  })
})

describe('per-item errors', () => {
  it('reports errors in a 202 to onError with the item they belong to, and never retries', async () => {
    const api = mockApi([
      {
        status: 202,
        body: {
          accepted: 1,
          dropped: [],
          errors: [{ index: 1, code: 'reserved_property', field: 'properties.$foo', message: 'Reserved' }],
          request_id: 'ray-2',
        },
      },
    ])
    const { client, errors } = makeClient({ fetch: api.fetch })
    client.track({ event: 'ok', distinctId: 'u', insertId: 'first' })
    client.track({ event: 'bad', distinctId: 'u', insertId: 'second', properties: { $foo: 1 } })
    await client.flush()
    expect(api.requests).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'item_errors', count: 1, status: 202, requestId: 'ray-2' })
    expect(errors[0]?.itemErrors).toEqual([
      {
        index: 1,
        code: 'reserved_property',
        field: 'properties.$foo',
        message: 'Reserved',
        insertId: 'second',
        event: 'bad',
      },
    ])
  })

  it('reports every item on 400 all_items_invalid', async () => {
    const api = mockApi([
      {
        status: 400,
        body: {
          error: { code: 'all_items_invalid', message: 'Every item failed', request_id: 'ray-3' },
          errors: [{ index: 0, code: 'missing_event_name', field: 'event' }],
        },
      },
    ])
    const { client, errors } = makeClient({ fetch: api.fetch })
    client.track({ event: 'x', distinctId: 'u', insertId: 'only' })
    await client.flush()
    expect(api.requests).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'item_errors', status: 400, apiCode: 'all_items_invalid' })
    expect(errors[0]?.itemErrors?.[0]).toMatchObject({ code: 'missing_event_name', insertId: 'only' })
  })

  it('stays quiet when a 202 has no errors, even with dropped items', async () => {
    const api = mockApi([accepted(1, { dropped: [{ index: 0, reason: 'bot_filtered' }] })])
    const { client, errors } = makeClient({ fetch: api.fetch })
    client.track({ event: 'x', distinctId: 'u' })
    await client.flush()
    expect(errors).toEqual([])
  })
})

describe('queue cap', () => {
  it('drops the newest items when full and reports a running count', async () => {
    const api = mockApi()
    const { client, errors } = makeClient({ fetch: api.fetch, maxQueueSize: 3, flushAt: 100 })
    for (let i = 0; i < 5; i++) client.track({ event: `e${i}`, distinctId: 'u' })
    expect(client.pending).toBe(3)
    expect(errors.map((e) => [e.code, e.dropped])).toEqual([
      ['queue_full', 1],
      ['queue_full', 2],
    ])
    await client.flush()
    expect(api.requests[0]?.json.items.map((i) => i.event)).toEqual(['e0', 'e1', 'e2'])
  })

  it('counts items in flight, so an outage cannot grow memory without bound', async () => {
    vi.useFakeTimers()
    const api = mockApi(() => ({ status: 503, headers: { 'Retry-After': '60' } }))
    const { client, errors } = makeClient({ fetch: api.fetch, maxQueueSize: 2, flushAt: 2 })
    client.track({ event: 'a', distinctId: 'u' })
    client.track({ event: 'b', distinctId: 'u' }) // triggers a flush that keeps retrying
    await vi.advanceTimersByTimeAsync(0)
    client.track({ event: 'c', distinctId: 'u' })
    expect(client.pending).toBe(2)
    expect(errors.map((e) => e.code)).toEqual(['queue_full'])
  })
})

describe('shutdown', () => {
  it('flushes, then refuses new calls', async () => {
    const api = mockApi()
    const { client, errors } = makeClient({ fetch: api.fetch, flushInterval: 5000 })
    client.track({ event: 'a', distinctId: 'u' })
    await client.shutdown()
    expect(api.requests).toHaveLength(1)
    client.track({ event: 'late', distinctId: 'u' })
    client.identify({ distinctId: 'u' })
    expect(errors.map((e) => e.code)).toEqual(['client_closed', 'client_closed'])
    expect(client.pending).toBe(0)
    // Idempotent.
    await client.shutdown()
    expect(api.requests).toHaveLength(1)
  })

  it('gives up at its deadline and reports what was not delivered', async () => {
    vi.useFakeTimers()
    const api = mockApi(() => 'hang')
    const { client, errors } = makeClient({ fetch: api.fetch, flushAt: 2, requestTimeout: 60_000 })
    for (let i = 0; i < 5; i++) client.track({ event: `e${i}`, distinctId: 'u' })
    let finished = false
    const done = client.shutdown({ timeout: 3000 }).then(() => {
      finished = true
    })
    await vi.advanceTimersByTimeAsync(2999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(finished).toBe(true)
    // Each pending flush reports its own undelivered items: 2 + 2 + 1.
    const timeouts = errors.filter((e) => e.code === 'shutdown_timeout')
    expect(timeouts.map((e) => e.count)).toEqual([2, 2, 1])
    expect(errors.every((e) => e.code === 'shutdown_timeout')).toBe(true)
    expect(client.pending).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops waiting on a long Retry-After at the deadline', async () => {
    vi.useFakeTimers()
    const api = mockApi(() => ({ status: 429, headers: { 'Retry-After': '60' } }))
    const { client, errors } = makeClient({ fetch: api.fetch })
    client.track({ event: 'a', distinctId: 'u' })
    const done = client.shutdown({ timeout: 10_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    await done
    expect(api.requests).toHaveLength(1)
    expect(errors.map((e) => [e.code, e.count])).toEqual([['shutdown_timeout', 1]])
  })
})

describe('edge mode', () => {
  it('starts no timers with flushInterval 0', () => {
    vi.useFakeTimers()
    const { client } = makeClient({ fetch: mockApi().fetch, flushInterval: 0 })
    client.track({ event: 'a', distinctId: 'u' })
    client.identify({ distinctId: 'u' })
    expect(vi.getTimerCount()).toBe(0)
    expect(client.pending).toBe(2)
  })

  it('flushWith hands the flush to waitUntil', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch, flushInterval: 0 })
    const waited: Promise<unknown>[] = []
    const ctx = { waitUntil: (promise: Promise<unknown>) => waited.push(promise) }
    client.track({ event: 'a', distinctId: 'u' })
    const returned = client.flushWith(ctx)
    expect(waited).toHaveLength(1)
    expect(waited[0]).toBe(returned)
    expect(api.requests).toHaveLength(0)
    await Promise.all(waited)
    expect(api.requests).toHaveLength(1)
  })

  it('flushWith also waits for a flushAt flush that already started', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const base = mockApi()
    const fetch: typeof base.fetch = async (url, init) => {
      await gate
      return base.fetch(url, init)
    }
    const { client } = makeClient({ fetch, flushAt: 1, flushInterval: 0 })
    client.track({ event: 'a', distinctId: 'u' }) // starts a background flush
    let settled = false
    const waited: Promise<unknown>[] = []
    client.flushWith({ waitUntil: (p) => waited.push(p.then(() => (settled = true))) })
    await tick()
    expect(settled).toBe(false)
    release()
    await Promise.all(waited)
    expect(base.requests).toHaveLength(1)
  })
})
