import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClickClacks, MAX_BODY_BYTES, NotYetSupportedError, VERSION } from '../src/index.js'
import { accepted, KEY, makeClient, mockApi } from './helpers.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('construction', () => {
  it('requires a key', () => {
    expect(() => new ClickClacks({ key: '' })).toThrow(/key/)
    expect(() => new ClickClacks(undefined as never)).toThrow(/key/)
  })

  it('refuses a public browser key', () => {
    expect(() => new ClickClacks({ key: 'pk_live_abc' })).toThrow(/public browser key/)
  })

  it('validates host and numeric options', () => {
    expect(() => new ClickClacks({ key: KEY, host: 'not a url' })).toThrow(/host/)
    expect(() => new ClickClacks({ key: KEY, host: 'ftp://x.test' })).toThrow(/host/)
    expect(() => new ClickClacks({ key: KEY, flushAt: 501 })).toThrow(/flushAt/)
    expect(() => new ClickClacks({ key: KEY, flushAt: 0 })).toThrow(/flushAt/)
    expect(() => new ClickClacks({ key: KEY, maxRetries: -1 })).toThrow(/maxRetries/)
  })

  it('has the documented defaults', () => {
    const client = new ClickClacks({ key: KEY, fetch: mockApi().fetch })
    expect(client.host).toBe('https://app.clickclacks.io')
    expect(client.flushAt).toBe(100)
    expect(client.flushInterval).toBe(5000)
    expect(client.maxQueueSize).toBe(10_000)
    expect(client.maxRetries).toBe(6)
    expect(client.requestTimeout).toBe(10_000)
  })

  it('never puts the key in an error message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = mockApi([{ status: 401, body: { error: { code: 'invalid_key', message: 'Unknown key' } } }])
    const client = new ClickClacks({ key: KEY, fetch: api.fetch, flushInterval: 0 })
    client.track({ event: 'x', distinctId: 'u' })
    await client.flush()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('request_rejected')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY)
  })
})

describe('the request', () => {
  it('posts to /api/v1/batch with the key, JSON and the SDK user agent', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch, host: 'https://example.test/' })
    client.track({ event: 'Invoice paid', distinctId: 'user_8412', properties: { amount_cents: 4900 } })
    await client.flush()
    expect(api.requests).toHaveLength(1)
    const [request] = api.requests
    expect(request?.url).toBe('https://example.test/api/v1/batch')
    expect(request?.headers).toMatchObject({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': `clickclacks-node/${VERSION}`,
    })
    expect(request?.headers.Origin).toBeUndefined()
  })

  it('maps track and identify to wire items', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch })
    const when = new Date('2026-09-25T14:03:11.402Z')
    client.identify({ distinctId: 'user_8412', anonymousId: 'per_k3J9sQ1xR2', properties: { plan: 'pro' } })
    client.track({
      event: 'Subscription started',
      distinctId: 'user_8412',
      sessionId: 'ses_abc',
      timestamp: when,
      insertId: 'sub_started_7f3a91',
      properties: { plan: 'pro', $revenue: 49, $currency: 'USD', $groups: { company: 'cmp_311' } },
    })
    client.track({ event: 'Epoch', anonymousId: 'per_k3J9sQ1xR2', timestamp: 1_758_808_991_402 })
    await client.flush()
    const items = api.requests[0]?.json.items ?? []
    expect(items[0]).toMatchObject({
      type: 'identify',
      distinct_id: 'user_8412',
      anonymous_id: 'per_k3J9sQ1xR2',
      properties: { plan: 'pro' },
    })
    expect(items[0]).not.toHaveProperty('event')
    expect(items[1]).toEqual({
      type: 'track',
      event: 'Subscription started',
      distinct_id: 'user_8412',
      session_id: 'ses_abc',
      timestamp: '2026-09-25T14:03:11.402Z',
      insert_id: 'sub_started_7f3a91',
      properties: { plan: 'pro', $revenue: 49, $currency: 'USD', $groups: { company: 'cmp_311' } },
    })
    expect(items[2]).toMatchObject({ event: 'Epoch', anonymous_id: 'per_k3J9sQ1xR2', timestamp: 1_758_808_991_402 })
    expect(items[2]).not.toHaveProperty('distinct_id')
  })

  it('stamps a timestamp at enqueue time and an insert_id on every item', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-25T10:00:00.000Z') })
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch })
    client.track({ event: 'a', distinctId: 'u' })
    vi.setSystemTime(new Date('2026-09-25T10:05:00.000Z'))
    client.identify({ distinctId: 'u' })
    await client.flush()
    const items = api.requests[0]?.json.items ?? []
    expect(items[0]?.timestamp).toBe('2026-09-25T10:00:00.000Z')
    expect(items[1]?.timestamp).toBe('2026-09-25T10:05:00.000Z')
    for (const item of items) expect(item.insert_id).toMatch(/^[0-9a-f]{32}$/)
    expect(items[0]?.insert_id).not.toBe(items[1]?.insert_id)
  })

  it('snapshots properties when queued, so later mutation does not change them', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch })
    const properties = { step: 1 }
    client.track({ event: 'a', distinctId: 'u', properties })
    properties.step = 2
    await client.flush()
    expect(api.requests[0]?.json.items[0]?.properties).toEqual({ step: 1 })
  })

  it('keeps one insert_id across retries of the same batch', async () => {
    vi.useFakeTimers()
    const api = mockApi([{ status: 503, headers: { 'Retry-After': '1' } }, accepted(1)])
    const { client } = makeClient({ fetch: api.fetch })
    client.track({ event: 'a', distinctId: 'u' })
    const done = client.flush()
    await vi.advanceTimersByTimeAsync(1000)
    await done
    expect(api.requests).toHaveLength(2)
    expect(api.requests[1]?.raw).toEqual(api.requests[0]?.raw)
  })
})

describe('invalid calls', () => {
  it('reports malformed calls to onError and queues nothing', async () => {
    const api = mockApi()
    const { client, errors } = makeClient({ fetch: api.fetch })
    client.track({ event: '', distinctId: 'u' })
    client.track({ event: 'no identity' })
    client.track({ event: 'bad props', distinctId: 'u', properties: [] as never })
    client.track({ event: 'bad time', distinctId: 'u', timestamp: new Date('nope') })
    client.identify({} as never)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    client.track({ event: 'circular', distinctId: 'u', properties: circular })
    expect(errors.map((e) => e.code)).toEqual(Array(6).fill('invalid_call'))
    expect(client.pending).toBe(0)
    await client.flush()
    expect(api.requests).toHaveLength(0)
  })

  it('reports an item too large for one request', () => {
    const { client, errors } = makeClient({ fetch: mockApi().fetch })
    client.track({ event: 'huge', distinctId: 'u', properties: { blob: 'x'.repeat(MAX_BODY_BYTES) } })
    expect(errors[0]?.code).toBe('item_too_large')
    expect(client.pending).toBe(0)
  })
})

describe('group', () => {
  it('is reserved and throws NotYetSupportedError', () => {
    const { client } = makeClient({ fetch: mockApi().fetch })
    expect(() => client.group({ groupType: 'company', groupId: 'cmp_311' })).toThrow(NotYetSupportedError)
    try {
      client.group({ groupType: 'company', groupId: 'cmp_311' })
    } catch (error) {
      expect((error as NotYetSupportedError).method).toBe('group')
      expect((error as Error).name).toBe('NotYetSupportedError')
    }
  })
})
