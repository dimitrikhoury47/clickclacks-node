/** Backoff base and cap: 500 ms × 2ⁿ, capped at 30 s, with full jitter. */
export const BACKOFF_BASE_MS = 500
export const BACKOFF_CAP_MS = 30_000
/** A server `Retry-After` wins, up to 5 minutes. */
export const RETRY_AFTER_CAP_MS = 300_000
/** Bodies over 1 KiB are gzipped. */
export const GZIP_THRESHOLD_BYTES = 1024

const encoder = new TextEncoder()

export function utf8Length(text: string): number {
  return encoder.encode(text).length
}

interface CryptoLike {
  randomUUID?: () => string
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T
}

/**
 * A fresh `insert_id`: `crypto.randomUUID()` with the dashes removed (32 hex characters).
 * Node 18 has no global `crypto` without a flag, so it falls back to 32 hex characters from
 * `Math.random`. That is unique enough for de-duplication, which is all an `insert_id` needs.
 */
export function generateInsertId(
  cryptoImpl: CryptoLike | undefined = (globalThis as { crypto?: CryptoLike }).crypto,
): string {
  if (cryptoImpl?.randomUUID) return cryptoImpl.randomUUID().replace(/-/g, '')
  if (cryptoImpl?.getRandomValues) {
    const bytes = cryptoImpl.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  let id = ''
  while (id.length < 32)
    id += Math.floor(Math.random() * 0x1_0000_0000)
      .toString(16)
      .padStart(8, '0')
  return id.slice(0, 32)
}

/** Full-jitter exponential backoff for retry `attempt` (0-based). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.floor(random() * ceiling)
}

/**
 * Parses `Retry-After` (delta seconds or an HTTP date) into milliseconds, capped at 5 minutes.
 * Returns `undefined` when the header is missing or unreadable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value == null) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  let ms: number
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    ms = Number(trimmed) * 1000
  } else {
    // An HTTP date always names a weekday or month; this also keeps `-5` from parsing as a year.
    if (!/[a-z]/i.test(trimmed)) return undefined
    const date = Date.parse(trimmed)
    if (Number.isNaN(date)) return undefined
    ms = date - now
  }
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, Math.ceil(ms)))
}

/** Gzips with the global `CompressionStream` (Node 18+, Workers). Returns `undefined` when unavailable. */
export async function gzip(text: string): Promise<Uint8Array | undefined> {
  const Compression = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream
  if (typeof Compression !== 'function') return undefined
  const stream = new Blob([text]).stream().pipeThrough(new Compression('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Resolves after `ms`, or early when `signal` aborts. Never rejects. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}
