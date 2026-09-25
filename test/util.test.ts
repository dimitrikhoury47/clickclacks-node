import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index.js'
import { backoffDelay, generateInsertId, parseRetryAfter } from '../src/util.js'

describe('parseRetryAfter', () => {
  it('reads delta seconds', () => {
    expect(parseRetryAfter('10')).toBe(10_000)
    expect(parseRetryAfter(' 5 ')).toBe(5_000)
    expect(parseRetryAfter('0')).toBe(0)
    expect(parseRetryAfter('1.5')).toBe(1_500)
  })

  it('reads an HTTP date', () => {
    const now = Date.parse('2026-09-25T12:00:00Z')
    expect(parseRetryAfter('Fri, 25 Sep 2026 12:00:30 GMT', now)).toBe(30_000)
    expect(parseRetryAfter('Fri, 25 Sep 2026 11:00:00 GMT', now)).toBe(0)
  })

  it('caps at 5 minutes and ignores junk', () => {
    expect(parseRetryAfter('86400')).toBe(300_000)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
    expect(parseRetryAfter('-5')).toBeUndefined()
  })
})

describe('backoffDelay', () => {
  it('stays inside [0, min(30 s, 500 ms × 2ⁿ))', () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const ceiling = Math.min(30_000, 500 * 2 ** attempt)
      expect(backoffDelay(attempt, () => 0)).toBe(0)
      expect(backoffDelay(attempt, () => 0.999999)).toBe(ceiling - 1)
      for (let i = 0; i < 50; i++) {
        const delay = backoffDelay(attempt)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThan(ceiling)
      }
    }
  })
})

describe('generateInsertId', () => {
  it('is randomUUID without dashes', () => {
    expect(generateInsertId({ randomUUID: () => '0a1b2c3d-0000-4000-8000-123456789abc' })).toBe(
      '0a1b2c3d000040008000123456789abc',
    )
    expect(generateInsertId()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('falls back without randomUUID (Node 18 has no global crypto)', () => {
    const viaBytes = generateInsertId({ getRandomValues: (a) => a })
    expect(viaBytes).toBe('0'.repeat(32))
    const ids = new Set(Array.from({ length: 1000 }, () => generateInsertId(undefined as never)))
    // An explicit undefined takes the default; pass an empty object to force Math.random.
    const fallback = new Set(Array.from({ length: 1000 }, () => generateInsertId({})))
    for (const id of [...ids, ...fallback]) expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(fallback.size).toBe(1000)
  })
})

it('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(VERSION).toBe(pkg.version)
})
