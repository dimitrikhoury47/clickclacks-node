// Loads the built package the way consumers do: import (ESM) and require (CJS) by name,
// through package.json "exports", and checks both expose the same API.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const esm = await import('@clickclacks/node')
const cjs = require('@clickclacks/node')

const expected = [
  'BATCH_PATH',
  'ClickClacks',
  'ClickClacksError',
  'DEFAULT_HOST',
  'MAX_BATCH_ITEMS',
  'MAX_BODY_BYTES',
  'NotYetSupportedError',
  'VERSION',
]
assert.deepEqual(Object.keys(esm).sort(), expected)
assert.deepEqual(
  Object.keys(cjs)
    .filter((k) => k !== '__esModule')
    .sort(),
  expected,
)
assert.equal(esm.VERSION, require('@clickclacks/node/package.json').version)

for (const mod of [esm, cjs]) {
  const client = new mod.ClickClacks({
    key: 'cks_live_x',
    flushInterval: 0,
    fetch: async () => new Response('{}', { status: 202 }),
  })
  assert.throws(() => client.group({ groupType: 'company', groupId: 'c' }), mod.NotYetSupportedError)
  client.track({ event: 'e', distinctId: 'u' })
  await client.shutdown()
}
console.log('package check passed: ESM and CJS entry points agree')
