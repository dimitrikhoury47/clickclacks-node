import type { ItemError } from './types.js'

/**
 * Codes the client reports through `onError`.
 *
 * - `queue_full`: a new item was dropped because `maxQueueSize` was reached. `dropped` is the running count.
 * - `invalid_call`: a `track`/`identify` call was malformed and nothing was queued.
 * - `item_too_large`: one item serialised to more than the 1 MiB request cap.
 * - `client_closed`: a call arrived after `shutdown()`.
 * - `item_errors`: the API refused some items; see `itemErrors`. Never retried.
 * - `request_rejected`: the API refused the whole request with a non-retryable status; see `apiCode`.
 * - `request_failed`: every retry failed; `count` items were lost.
 * - `shutdown_timeout`: `shutdown()` hit its deadline; `count` items were not delivered.
 */
export type ClickClacksErrorCode =
  | 'queue_full'
  | 'invalid_call'
  | 'item_too_large'
  | 'client_closed'
  | 'item_errors'
  | 'request_rejected'
  | 'request_failed'
  | 'shutdown_timeout'

export interface ClickClacksErrorDetails {
  /** How many items this error concerns. */
  count?: number
  /** For `queue_full`: items dropped since the client was created. */
  dropped?: number
  /** The last HTTP status, when there was one. */
  status?: number
  /** The API's error code, for example `invalid_key` or `rate_limited`. */
  apiCode?: string
  /** The API's `request_id` (the `cf-ray` value), for support. */
  requestId?: string
  itemErrors?: ItemError[]
  cause?: unknown
}

export class ClickClacksError extends Error {
  readonly code: ClickClacksErrorCode
  readonly count?: number
  readonly dropped?: number
  readonly status?: number
  readonly apiCode?: string
  readonly requestId?: string
  readonly itemErrors?: ItemError[]

  constructor(code: ClickClacksErrorCode, message: string, details: ClickClacksErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'ClickClacksError'
    this.code = code
    this.count = details.count
    this.dropped = details.dropped
    this.status = details.status
    this.apiCode = details.apiCode
    this.requestId = details.requestId
    this.itemErrors = details.itemErrors
  }
}

/** Thrown by reserved methods (`group`) until the API supports them. */
export class NotYetSupportedError extends Error {
  readonly method: string

  constructor(method: string, message: string) {
    super(message)
    this.name = 'NotYetSupportedError'
    this.method = method
  }
}
