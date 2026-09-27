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
  it('queues a group item with no person', async () => {
    const api = mockApi()
    const { client, errors } = makeClient({ fetch: api.fetch })
    const when = new Date('2026-09-25T14:03:11.402Z')
    client.group({
      groupType: 'company',
      groupId: 'acme',
      properties: { plan: 'pro', seats: 41 },
      timestamp: when,
      insertId: 'grp_acme_1',
    })
    client.group({ groupType: 'workspace', groupId: 311 })
    client.group({ groupType: 'team', groupId: '  cmp_311  ' })
    expect(client.pending).toBe(3)
    await client.flush()
    expect(errors).toEqual([])
    const items = api.requests[0]?.json.items ?? []
    expect(items[0]).toEqual({
      type: 'group',
      group_type: 'company',
      group_id: 'acme',
      timestamp: '2026-09-25T14:03:11.402Z',
      insert_id: 'grp_acme_1',
      properties: { plan: 'pro', seats: 41 },
    })
    expect(items[1]).toMatchObject({ type: 'group', group_type: 'workspace', group_id: '311' })
    expect(items[1]?.insert_id).toMatch(/^[0-9a-f]{32}$/)
    expect(items[1]).not.toHaveProperty('properties')
    expect(items[2]).toMatchObject({ group_id: 'cmp_311' })
    for (const item of items) {
      expect(item).not.toHaveProperty('distinct_id')
      expect(item).not.toHaveProperty('anonymous_id')
      expect(item).not.toHaveProperty('event')
    }
  })

  it('reports invalid group calls to onError and queues nothing', async () => {
    const api = mockApi()
    const { client, errors } = makeClient({ fetch: api.fetch })
    client.group({ groupType: 'Company', groupId: 'acme' })
    client.group({ groupType: '', groupId: 'acme' })
    client.group({ groupType: 'x'.repeat(65), groupId: 'acme' })
    client.group({ groupType: 'company', groupId: '' })
    client.group({ groupType: 'company', groupId: '   ' })
    client.group({ groupType: 'company', groupId: 'a'.repeat(256) })
    client.group({ groupType: 'company', groupId: 'ac\nme' })
    client.group({ groupType: 'company', groupId: Number.NaN })
    client.group({ groupType: 'company', groupId: { id: 1 } as never })
    client.group({ groupType: 'company', groupId: 'acme', properties: [] as never })
    client.group(undefined as never)
    expect(errors.map((e) => e.code)).toEqual(Array(11).fill('invalid_call'))
    expect(client.pending).toBe(0)
    await client.flush()
    expect(api.requests).toHaveLength(0)
  })

  it('accepts a 255-character group id', () => {
    const { client, errors } = makeClient({ fetch: mockApi().fetch })
    client.group({ groupType: 'company', groupId: 'a'.repeat(255) })
    expect(errors).toEqual([])
    expect(client.pending).toBe(1)
  })

  it('no longer throws, and NotYetSupportedError stays exported', () => {
    const { client } = makeClient({ fetch: mockApi().fetch })
    expect(() => client.group({ groupType: 'company', groupId: 'cmp_311' })).not.toThrow()
    const error = new NotYetSupportedError('alias', 'coming')
    expect(error.name).toBe('NotYetSupportedError')
    expect(error.method).toBe('alias')
  })

  it('is refused after shutdown', async () => {
    const { client, errors } = makeClient({ fetch: mockApi().fetch })
    await client.shutdown()
    client.group({ groupType: 'company', groupId: 'acme' })
    expect(errors.map((e) => e.code)).toEqual(['client_closed'])
  })
})

describe('track groups option', () => {
  it('writes groups into properties.$groups', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch })
    client.track({
      event: 'Seats changed',
      distinctId: 'user_8412',
      properties: { seats: 41 },
      groups: { company: 'acme' },
    })
    client.track({ event: 'No props', distinctId: 'u', groups: { company: 'acme', team: 'core' } })
    await client.flush()
    const items = api.requests[0]?.json.items ?? []
    expect(items[0]?.properties).toEqual({ seats: 41, $groups: { company: 'acme' } })
    expect(items[1]?.properties).toEqual({ $groups: { company: 'acme', team: 'core' } })
  })

  it('keeps properties.$groups working, and the option wins when both are sent', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch })
    const properties = { seats: 41, $groups: { company: 'old', team: 'core' } }
    client.track({ event: 'a', distinctId: 'u', properties: { $groups: { company: 'cmp_311' } } })
    client.track({ event: 'b', distinctId: 'u', properties, groups: { company: 'new' } })
    await client.flush()
    const items = api.requests[0]?.json.items ?? []
    expect(items[0]?.properties).toEqual({ $groups: { company: 'cmp_311' } })
    expect(items[1]?.properties).toEqual({ seats: 41, $groups: { company: 'new' } })
    // The caller's object is not mutated.
    expect(properties.$groups).toEqual({ company: 'old', team: 'core' })
  })

  it('converts number ids and trims ids', async () => {
    const api = mockApi()
    const { client } = makeClient({ fetch: api.fetch })
    client.track({ event: 'a', distinctId: 'u', groups: { company: 311 as never, team: ' core ' } })
    await client.flush()
    expect(api.requests[0]?.json.items[0]?.properties).toEqual({ $groups: { company: '311', team: 'core' } })
  })

  it('reports an invalid groups option and queues nothing', () => {
    const { client, errors } = makeClient({ fetch: mockApi().fetch })
    client.track({ event: 'a', distinctId: 'u', groups: { Company: 'acme' } })
    client.track({ event: 'a', distinctId: 'u', groups: { company: '' } })
    client.track({ event: 'a', distinctId: 'u', groups: { company: 'a\u0000b' } })
    client.track({ event: 'a', distinctId: 'u', groups: ['acme'] as never })
    client.track({ event: 'a', distinctId: 'u', groups: { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6' } })
    expect(errors.map((e) => e.code)).toEqual(Array(5).fill('invalid_call'))
    expect(client.pending).toBe(0)
  })

  it('accepts five group types', () => {
    const { client, errors } = makeClient({ fetch: mockApi().fetch })
    client.track({ event: 'a', distinctId: 'u', groups: { a: '1', b: '2', c: '3', d: '4', e: '5' } })
    expect(errors).toEqual([])
    expect(client.pending).toBe(1)
  })
})

describe('warnings', () => {
  it('passes the API warnings to onWarning with the item they belong to', async () => {
    const api = mockApi([
      accepted(2, {
        warnings: [
          { index: 1, code: 'group_trait_dropped', field: 'properties.email', message: 'Looks like an email address' },
        ],
      }),
    ])
    const warnings: unknown[] = []
    const { client, errors } = makeClient({ fetch: api.fetch, onWarning: (w) => warnings.push(...w) })
    client.track({ event: 'a', distinctId: 'u' })
    client.group({ groupType: 'company', groupId: 'acme', insertId: 'grp_1', properties: { email: 'a@b.test' } })
    await client.flush()
    expect(errors).toEqual([])
    expect(warnings).toEqual([
      {
        index: 1,
        code: 'group_trait_dropped',
        field: 'properties.email',
        message: 'Looks like an email address',
        insertId: 'grp_1',
        event: '$group_identify',
      },
    ])
  })

  it('logs warnings with console.warn by default and ignores an empty list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = mockApi([
      accepted(1),
      accepted(1, { warnings: [{ index: 0, code: 'group_trait_dropped', field: 'properties.phone' }] }),
    ])
    const client = new ClickClacks({ key: KEY, fetch: api.fetch, flushInterval: 0, onError: () => {} })
    client.group({ groupType: 'company', groupId: 'acme' })
    await client.flush()
    expect(warn).not.toHaveBeenCalled()
    client.group({ groupType: 'company', groupId: 'acme' })
    await client.flush()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('group_trait_dropped')
  })

  it('never lets an onWarning handler break delivery', async () => {
    const api = mockApi([accepted(1, { warnings: [{ index: 0, code: 'group_trait_dropped' }] })])
    const { client, errors } = makeClient({
      fetch: api.fetch,
      onWarning: () => {
        throw new Error('boom')
      },
    })
    client.group({ groupType: 'company', groupId: 'acme' })
    await expect(client.flush()).resolves.toBeUndefined()
    expect(errors).toEqual([])
    expect(client.pending).toBe(0)
  })
})
