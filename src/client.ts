import { ClickClacksError, NotYetSupportedError } from './errors.js'
import type {
  ClickClacksOptions,
  FetchLike,
  GroupParams,
  IdentifyParams,
  ItemError,
  Properties,
  ResponseLike,
  ShutdownOptions,
  Timestamp,
  TrackParams,
  WaitUntilContext,
} from './types.js'
import {
  backoffDelay,
  GZIP_THRESHOLD_BYTES,
  generateInsertId,
  gzip,
  parseRetryAfter,
  sleep,
  utf8Length,
} from './util.js'
import { VERSION } from './version.js'

export const DEFAULT_HOST = 'https://app.clickclacks.io'
export const BATCH_PATH = '/api/v1/batch'
/** The API's cap is 500 items per request. */
export const MAX_BATCH_ITEMS = 500
/** The API's cap is 1 MiB uncompressed; stay a little under it. */
export const MAX_BODY_BYTES = 1_000_000
const ENVELOPE_BYTES = utf8Length('{"items":[]}')
const MAX_ITEM_BYTES = MAX_BODY_BYTES - ENVELOPE_BYTES

const DEFAULTS = {
  host: DEFAULT_HOST,
  flushAt: 100,
  flushInterval: 5_000,
  maxQueueSize: 10_000,
  maxRetries: 6,
  requestTimeout: 10_000,
  shutdownTimeout: 10_000,
}

/** One queued item, serialised when it was enqueued so later mutation can't change it. */
interface QueuedItem {
  json: string
  bytes: number
  insertId: string
  event: string
}

interface WireItem {
  type: 'track' | 'identify'
  event?: string
  distinct_id?: string
  anonymous_id?: string
  session_id?: string
  timestamp: string | number
  insert_id: string
  properties?: Properties
}

interface ApiItemError {
  index?: unknown
  code?: unknown
  field?: unknown
  message?: unknown
}

interface ApiBody {
  errors?: ApiItemError[]
  error?: { code?: unknown; message?: unknown; request_id?: unknown }
  request_id?: unknown
}

type Outcome = 'done' | 'aborted'

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function optionalId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value
  throw new TypeError('must be a string')
}

function wireTimestamp(value: Timestamp | undefined): string | number {
  if (value === undefined) return new Date().toISOString()
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('timestamp is an invalid Date')
    return value.toISOString()
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('timestamp must be finite epoch milliseconds')
    return value
  }
  if (typeof value === 'string' && value !== '') return value
  throw new TypeError('timestamp must be a Date, an ISO 8601 string or epoch milliseconds')
}

function wireProperties(value: unknown): Properties | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('properties must be a plain object')
  return value as Properties
}

function parseJson(text: string): ApiBody | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as ApiBody) : undefined
  } catch {
    return undefined
  }
}

function positiveInt(name: string, value: number | undefined, fallback: number, min: number, max = Infinity): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`ClickClacks: ${name} must be a number from ${min} to ${max}`)
  }
  return Math.floor(value)
}

/**
 * The ClickClacks server-side client. Queue events with `track` and `identify`; they are
 * batched, gzipped and retried safely. Call `shutdown()` before the process exits, or
 * `flushWith(ctx)` at the end of each request on Workers.
 */
export class ClickClacks {
  readonly host: string
  readonly flushAt: number
  readonly flushInterval: number
  readonly maxQueueSize: number
  readonly maxRetries: number
  readonly requestTimeout: number

  readonly #key: string
  readonly #url: string
  readonly #fetch: FetchLike
  readonly #onError: (error: ClickClacksError) => void
  readonly #closing = new AbortController()

  #queue: QueuedItem[] = []
  #inFlight = 0
  #dropped = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #chain: Promise<void> = Promise.resolve()
  #closed = false
  #shutdown: Promise<void> | undefined

  constructor(options: ClickClacksOptions) {
    if (!options || typeof options.key !== 'string' || options.key.trim() === '') {
      throw new TypeError('ClickClacks: `key` is required (a cks_live_… server key)')
    }
    if (options.key.startsWith('pk_')) {
      throw new TypeError('ClickClacks: that is a public browser key. Use a secret server key (cks_live_…)')
    }
    this.#key = options.key.trim()

    const host = (options.host ?? DEFAULTS.host).replace(/\/+$/, '')
    let protocol: string
    try {
      protocol = new URL(host).protocol
    } catch {
      throw new TypeError('ClickClacks: `host` must be an absolute http(s) URL')
    }
    if (protocol !== 'https:' && protocol !== 'http:') {
      throw new TypeError('ClickClacks: `host` must be an absolute http(s) URL')
    }
    this.host = host
    this.#url = host + BATCH_PATH

    this.flushAt = positiveInt('flushAt', options.flushAt, DEFAULTS.flushAt, 1, MAX_BATCH_ITEMS)
    this.flushInterval = positiveInt('flushInterval', options.flushInterval, DEFAULTS.flushInterval, 0)
    this.maxQueueSize = positiveInt('maxQueueSize', options.maxQueueSize, DEFAULTS.maxQueueSize, 1)
    this.maxRetries = positiveInt('maxRetries', options.maxRetries, DEFAULTS.maxRetries, 0)
    this.requestTimeout = positiveInt('requestTimeout', options.requestTimeout, DEFAULTS.requestTimeout, 1)

    const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined)
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('ClickClacks: no global fetch. Use Node 18+ or pass `fetch`')
    }
    this.#fetch = options.fetch ?? ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init))
    this.#onError = options.onError ?? ((error) => console.warn(`[clickclacks] ${error.code}: ${error.message}`))
  }

  /** Items queued or in flight. */
  get pending(): number {
    return this.#queue.length + this.#inFlight
  }

  /** Queues an event. Never throws for bad input: problems go to `onError`. */
  track(params: TrackParams): void {
    let item: WireItem
    try {
      if (!params || typeof params.event !== 'string' || params.event.trim() === '') {
        throw new TypeError('track needs an `event` name')
      }
      const distinctId = optionalId(params.distinctId)
      const anonymousId = optionalId(params.anonymousId)
      if (!distinctId && !anonymousId) throw new TypeError('track needs a `distinctId` or an `anonymousId`')
      item = {
        type: 'track',
        event: params.event,
        distinct_id: distinctId,
        anonymous_id: anonymousId,
        session_id: optionalId(params.sessionId),
        timestamp: wireTimestamp(params.timestamp),
        insert_id: optionalId(params.insertId) || generateInsertId(),
        properties: wireProperties(params.properties),
      }
    } catch (error) {
      this.#invalid(error)
      return
    }
    this.#enqueue(item, item.event as string)
  }

  /** Queues an identify call: links `anonymousId` (if given) to `distinctId` and records traits. */
  identify(params: IdentifyParams): void {
    let item: WireItem
    try {
      const distinctId = optionalId(params?.distinctId)
      if (!distinctId) throw new TypeError('identify needs a `distinctId`')
      item = {
        type: 'identify',
        distinct_id: distinctId,
        anonymous_id: optionalId(params.anonymousId),
        timestamp: wireTimestamp(params.timestamp),
        insert_id: optionalId(params.insertId) || generateInsertId(),
        properties: wireProperties(params.properties),
      }
    } catch (error) {
      this.#invalid(error)
      return
    }
    this.#enqueue(item, '$identify')
  }

  /**
   * Reserved for Groups. Always throws `NotYetSupportedError` until the API accepts group
   * items. Until then, send group membership on events as `properties.$groups`.
   */
  group(_params: GroupParams): never {
    throw new NotYetSupportedError(
      'group',
      'ClickClacks: group() is coming with Groups. For now, send `$groups` in track() properties',
    )
  }

  /**
   * Sends everything queued now. Resolves when those items are delivered, refused or
   * given up on (failures go to `onError`). Never rejects.
   */
  flush(): Promise<void> {
    this.#clearTimer()
    const items = this.#queue
    this.#queue = []
    this.#inFlight += items.length
    const run = this.#chain
      .then(() => this.#send(items))
      .catch((error: unknown) => {
        this.#report(
          new ClickClacksError('request_failed', `Unexpected client error: ${(error as Error)?.message ?? error}`, {
            cause: error,
          }),
        )
      })
    this.#chain = run
    return run
  }

  /**
   * Edge mode: `ctx.waitUntil(clickclacks.flush())`. Call it at the end of each request on
   * Workers, with `flushInterval: 0`.
   */
  flushWith(ctx: WaitUntilContext): Promise<void> {
    const run = this.flush()
    ctx.waitUntil(run)
    return run
  }

  /**
   * Flushes, stops the timer and refuses new calls. Gives up after `timeout` ms (default
   * 10 s) and reports what was left as `shutdown_timeout`. Safe to call more than once.
   */
  shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (this.#shutdown) return this.#shutdown
    const timeout = positiveInt('timeout', options.timeout, DEFAULTS.shutdownTimeout, 0)
    this.#closed = true
    const done = this.flush()
    this.#shutdown = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeout)
      })
      const winner = await Promise.race([done.then(() => 'done' as const), deadline])
      clearTimeout(timer)
      if (winner === 'timeout') {
        this.#closing.abort()
        await done
      }
    })()
    return this.#shutdown
  }

  #invalid(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.#report(new ClickClacksError('invalid_call', message, { count: 1, cause: error }))
  }

  #enqueue(item: WireItem, event: string): void {
    if (this.#closed) {
      this.#report(
        new ClickClacksError('client_closed', 'The client was shut down; the item was not queued', { count: 1 }),
      )
      return
    }
    let json: string
    try {
      json = JSON.stringify(item)
    } catch (error) {
      this.#invalid(new TypeError(`properties are not JSON-serialisable: ${(error as Error).message}`))
      return
    }
    const bytes = utf8Length(json)
    if (bytes > MAX_ITEM_BYTES) {
      this.#report(
        new ClickClacksError('item_too_large', `An item is ${bytes} bytes, over the 1 MiB request cap`, { count: 1 }),
      )
      return
    }
    if (this.pending >= this.maxQueueSize) {
      this.#dropped += 1
      this.#report(
        new ClickClacksError(
          'queue_full',
          `The queue holds ${this.maxQueueSize} items; the new item was dropped (${this.#dropped} dropped so far)`,
          { count: 1, dropped: this.#dropped },
        ),
      )
      return
    }
    this.#queue.push({ json, bytes, insertId: item.insert_id, event })
    if (this.#queue.length >= this.flushAt) {
      void this.flush()
    } else if (this.flushInterval > 0 && this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined
        void this.flush()
      }, this.flushInterval)
      // Don't hold a Node process open just for the timer. Call shutdown() before exit.
      ;(this.#timer as { unref?: () => void }).unref?.()
    }
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  #report(error: ClickClacksError): void {
    try {
      this.#onError(error)
    } catch {
      // An onError handler must never break delivery.
    }
  }

  /** Splits into batches of ≤ flushAt items and ≤ 1 MiB, then sends them in order. */
  async #send(items: QueuedItem[]): Promise<void> {
    const batches: QueuedItem[][] = []
    let current: QueuedItem[] = []
    let currentBytes = ENVELOPE_BYTES
    for (const item of items) {
      const added = item.bytes + (current.length > 0 ? 1 : 0)
      if (current.length > 0 && (current.length >= this.flushAt || currentBytes + added > MAX_BODY_BYTES)) {
        batches.push(current)
        current = []
        currentBytes = ENVELOPE_BYTES
      }
      currentBytes += item.bytes + (current.length > 0 ? 1 : 0)
      current.push(item)
    }
    if (current.length > 0) batches.push(current)

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i] as QueuedItem[]
      try {
        const outcome = this.#closing.signal.aborted ? 'aborted' : await this.#sendBatch(batch)
        if (outcome === 'aborted') {
          const left = batches.slice(i).reduce((sum, b) => sum + b.length, 0)
          // The finally below releases this batch; release the ones never attempted too.
          this.#inFlight -= left - batch.length
          this.#report(
            new ClickClacksError('shutdown_timeout', `shutdown() timed out; ${left} items were not delivered`, {
              count: left,
            }),
          )
          return
        }
      } finally {
        this.#inFlight -= batch.length
      }
    }
  }

  async #sendBatch(batch: QueuedItem[]): Promise<Outcome> {
    const body = `{"items":[${batch.map((item) => item.json).join(',')}]}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#key}`,
      'Content-Type': 'application/json',
      'User-Agent': `clickclacks-node/${VERSION}`,
    }
    let payload: string | Uint8Array = body
    if (utf8Length(body) > GZIP_THRESHOLD_BYTES) {
      const compressed = await gzip(body).catch(() => undefined)
      if (compressed) {
        payload = compressed
        headers['Content-Encoding'] = 'gzip'
      }
    }

    let lastStatus: number | undefined
    let lastBody: ApiBody | undefined
    let lastError: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (this.#closing.signal.aborted) return 'aborted'
      let response: ResponseLike | undefined
      let text = ''
      const controller = new AbortController()
      const abort = () => controller.abort()
      const timer = setTimeout(abort, this.requestTimeout)
      this.#closing.signal.addEventListener('abort', abort)
      try {
        response = await this.#fetch(this.#url, { method: 'POST', headers, body: payload, signal: controller.signal })
        text = await response.text()
      } catch (error) {
        // A network error or a timeout: retryable.
        response = undefined
        lastError = error
        lastStatus = undefined
        lastBody = undefined
      } finally {
        clearTimeout(timer)
        this.#closing.signal.removeEventListener('abort', abort)
      }
      if (this.#closing.signal.aborted) return 'aborted'
      if (response === undefined) {
        if (attempt < this.maxRetries) await sleep(backoffDelay(attempt), this.#closing.signal)
        continue
      }

      const status = response.status
      const parsed = parseJson(text)
      if (status >= 200 && status < 300) {
        this.#reportItemErrors(batch, parsed, status)
        return 'done'
      }
      if (status === 413 && batch.length > 1) {
        // The API measured the body over its cap: split and resend.
        const half = Math.ceil(batch.length / 2)
        const first = await this.#sendBatch(batch.slice(0, half))
        if (first === 'aborted') return 'aborted'
        return this.#sendBatch(batch.slice(half))
      }
      if (!isRetryableStatus(status)) {
        if (!this.#reportItemErrors(batch, parsed, status)) {
          const apiCode = typeof parsed?.error?.code === 'string' ? parsed.error.code : undefined
          const apiMessage = typeof parsed?.error?.message === 'string' ? parsed.error.message : `HTTP ${status}`
          this.#report(
            new ClickClacksError('request_rejected', `The API refused ${batch.length} items: ${apiMessage}`, {
              count: batch.length,
              status,
              apiCode,
              requestId: requestIdOf(parsed),
            }),
          )
        }
        return 'done'
      }
      lastStatus = status
      lastBody = parsed
      lastError = undefined
      if (attempt < this.maxRetries) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
        await sleep(retryAfter ?? backoffDelay(attempt), this.#closing.signal)
      }
    }
    if (this.#closing.signal.aborted) return 'aborted'

    const apiCode = typeof lastBody?.error?.code === 'string' ? lastBody.error.code : undefined
    const reason =
      lastStatus !== undefined
        ? `HTTP ${lastStatus}${apiCode ? ` ${apiCode}` : ''}`
        : lastError instanceof Error
          ? lastError.message
          : 'network error'
    this.#report(
      new ClickClacksError(
        'request_failed',
        `Gave up on ${batch.length} items after ${this.maxRetries + 1} attempts (${reason})`,
        { count: batch.length, status: lastStatus, apiCode, requestId: requestIdOf(lastBody), cause: lastError },
      ),
    )
    return 'done'
  }

  /** Reports per-item errors; returns false when the body carried none. */
  #reportItemErrors(batch: QueuedItem[], body: ApiBody | undefined, status: number): boolean {
    const nested = (body?.error as { errors?: unknown } | undefined)?.errors
    const errors: ApiItemError[] = Array.isArray(body?.errors) ? body.errors : Array.isArray(nested) ? nested : []
    if (errors.length === 0) return false
    const itemErrors: ItemError[] = errors.map((raw) => {
      const index = typeof raw.index === 'number' ? raw.index : -1
      const item = batch[index]
      return {
        index,
        code: typeof raw.code === 'string' ? raw.code : 'unknown',
        field: typeof raw.field === 'string' ? raw.field : undefined,
        message: typeof raw.message === 'string' ? raw.message : undefined,
        insertId: item?.insertId,
        event: item?.event,
      }
    })
    const codes = [...new Set(itemErrors.map((e) => e.code))].join(', ')
    this.#report(
      new ClickClacksError('item_errors', `The API refused ${itemErrors.length} of ${batch.length} items (${codes})`, {
        count: itemErrors.length,
        status,
        apiCode: typeof body?.error?.code === 'string' ? body.error.code : undefined,
        requestId: requestIdOf(body),
        itemErrors,
      }),
    )
    return true
  }
}

function requestIdOf(body: ApiBody | undefined): string | undefined {
  if (typeof body?.request_id === 'string') return body.request_id
  if (typeof body?.error?.request_id === 'string') return body.error.request_id
  return undefined
}
