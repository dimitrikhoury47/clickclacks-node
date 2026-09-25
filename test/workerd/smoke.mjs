// Runs the built ESM bundle inside workerd (through Miniflare) as a Worker would:
// a client at module scope, flushInterval 0, and flushWith(ctx) at the end of each request.
// Outbound fetches are captured, so nothing leaves the machine.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

const sdk = readFileSync(new URL('../../dist/index.mjs', import.meta.url), 'utf8')

const worker = `
import { ClickClacks, NotYetSupportedError } from './sdk.mjs'

const errors = []
const clickclacks = new ClickClacks({
  key: 'cks_live_smoke000000000000000000000000000000000',
  host: 'https://ingest.test',
  flushInterval: 0,
  onError: (e) => errors.push(e.code),
})

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname === '/errors') return Response.json(errors)
    if (url.pathname === '/group') {
      try { clickclacks.group({ groupType: 'company', groupId: 'c1' }) }
      catch (e) { return Response.json({ threw: e instanceof NotYetSupportedError }) }
      return Response.json({ threw: false })
    }
    const n = Number(url.searchParams.get('n') ?? '1')
    const pad = url.searchParams.get('pad') ?? ''
    clickclacks.identify({ distinctId: 'user_1', anonymousId: 'per_abc' })
    for (let i = 0; i < n; i++) {
      clickclacks.track({ event: 'Worker event', distinctId: 'user_1', properties: { i, pad, path: url.pathname } })
    }
    clickclacks.flushWith(ctx)
    return new Response('ok')
  },
}
`

const captured = []
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: [
      { type: 'ESModule', path: 'worker.mjs', contents: worker },
      { type: 'ESModule', path: 'sdk.mjs', contents: sdk },
    ],
    compatibilityDate: '2025-09-01',
    outboundService: async (request) => {
      const raw = new Uint8Array(await request.arrayBuffer())
      const gz = request.headers.get('content-encoding') === 'gzip'
      const text = gz ? gunzipSync(raw).toString('utf8') : new TextDecoder().decode(raw)
      const json = JSON.parse(text)
      captured.push({ url: request.url, headers: Object.fromEntries(request.headers), gz, json })
      // First request of the run is rate limited once, to exercise Retry-After inside workerd.
      if (captured.length === 1) {
        return new Response(JSON.stringify({ error: { code: 'rate_limited' } }), {
          status: 429,
          headers: { 'Retry-After': '1', 'content-type': 'application/json' },
        })
      }
      return Response.json(
        { accepted: json.items.length, dropped: [], errors: [], request_id: 'smoke' },
        { status: 202 },
      )
    },
  }),
)

async function waitFor(check, label, ms = 15_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

try {
  const small = await mf.dispatchFetch('https://worker.test/a?n=2')
  assert.equal(await small.text(), 'ok')
  // 429 then the retry after Retry-After: 1, all inside waitUntil.
  await waitFor(() => captured.length >= 2, 'the retried small batch')
  assert.equal(captured[0].json.items.length, 3)
  assert.deepEqual(captured[1].json, captured[0].json, 'the retry resends the same insert_ids')
  assert.equal(captured[1].url, 'https://ingest.test/api/v1/batch')
  assert.equal(captured[1].headers.authorization, 'Bearer cks_live_smoke000000000000000000000000000000000')
  assert.match(captured[1].headers['user-agent'], /^clickclacks-node\/\d+\.\d+\.\d+$/)
  assert.equal(captured[1].headers.origin, undefined)
  assert.equal(captured[1].gz, false)
  assert.deepEqual(
    captured[1].json.items.map((i) => i.type),
    ['identify', 'track', 'track'],
  )
  for (const item of captured[1].json.items) assert.match(item.insert_id, /^[0-9a-f]{32}$/)

  // A second request reuses the module-scope client; this body is big enough to gzip.
  const big = await mf.dispatchFetch(`https://worker.test/b?n=20&pad=${'x'.repeat(200)}`)
  assert.equal(await big.text(), 'ok')
  await waitFor(() => captured.length >= 3, 'the gzipped batch')
  assert.equal(captured[2].gz, true)
  assert.equal(captured[2].json.items.length, 21)

  const group = await (await mf.dispatchFetch('https://worker.test/group')).json()
  assert.deepEqual(group, { threw: true })
  const errors = await (await mf.dispatchFetch('https://worker.test/errors')).json()
  assert.deepEqual(errors, [])

  console.log(`workerd smoke passed: ${captured.length} requests, gzip and Retry-After exercised in workerd`)
} finally {
  await mf.dispose()
}
