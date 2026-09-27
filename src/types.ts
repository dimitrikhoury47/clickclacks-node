/** A JSON object of event properties or identify traits. */
export type Properties = Record<string, unknown>

/** When the event happened: a `Date`, an ISO 8601 string with an offset, or epoch milliseconds. */
export type Timestamp = Date | string | number

export interface TrackParams {
  /** The event name, 1–128 characters. Names starting with `$` are reserved. */
  event: string
  /** Your user ID. One of `distinctId` or `anonymousId` is required. */
  distinctId?: string
  /** A `per_…` browser key, to attach a server event to a known anonymous browser. */
  anonymousId?: string
  /** A `ses_…` session ID, to join a browser session. */
  sessionId?: string
  /** Defaults to the moment `track` is called. */
  timestamp?: Timestamp
  /** 1–80 characters of `[A-Za-z0-9_-]`. Generated when omitted, so retries are always safe. */
  insertId?: string
  properties?: Properties
  /**
   * The groups this event belongs to, as `{ groupType: groupId }`, for example
   * `{ company: 'cmp_311' }`. At most 5 entries. Written to `properties.$groups`; when both
   * are sent, this option replaces `properties.$groups`.
   */
  groups?: Record<string, string>
}

export interface IdentifyParams {
  /** Your user ID. Required. */
  distinctId: string
  /** The browser key to link to this user. */
  anonymousId?: string
  /** Defaults to the moment `identify` is called. */
  timestamp?: Timestamp
  insertId?: string
  /** Traits, such as `plan`. Prefer an opaque ID over an email address as `distinctId`. */
  properties?: Properties
}

/** A group profile: its type, its ID and its traits. */
export interface GroupParams {
  /** 1–64 characters of `[a-z0-9_]`, for example `company`. */
  groupType: string
  /** Your ID for the group, 1–255 characters. Numbers are sent as strings. Prefer an opaque ID. */
  groupId: string | number
  /** Traits, such as `plan`. The newest call replaces the whole set, so send every trait each time. */
  properties?: Properties
  /** Defaults to the moment `group` is called. */
  timestamp?: Timestamp
  /** 1–80 characters of `[A-Za-z0-9_-]`. Generated when omitted, so retries are always safe. */
  insertId?: string
}

/** The subset of a `fetch` Response the client reads. */
export interface ResponseLike {
  readonly status: number
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
}

export interface RequestInitLike {
  method: 'POST'
  headers: Record<string, string>
  body: string | Uint8Array
  signal: AbortSignal
}

/** A `fetch`-compatible function. Defaults to the global `fetch`. */
export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>

/** The part of a Workers `ExecutionContext` that `flushWith` uses. */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void
}

export interface ClickClacksOptions {
  /** A secret server key (`cks_live_…`, or a legacy `sk_live_…`). Never a public `pk_live_` key. */
  key: string
  /** Default `https://app.clickclacks.io`. */
  host?: string
  /** Items per batch, 1–500. Default 100. A full queue of this size flushes at once. */
  flushAt?: number
  /** Milliseconds between automatic flushes. Default 5,000. `0` disables the timer (edge mode). */
  flushInterval?: number
  /** Items held in memory, queued or in flight. Default 10,000. New items are dropped when full. */
  maxQueueSize?: number
  /** Retries after the first attempt. Default 6. */
  maxRetries?: number
  /** Milliseconds before one request is abandoned and retried. Default 10,000. */
  requestTimeout?: number
  /** Called for dropped items, per-item errors and final failures. Default: `console.warn`. */
  onError?: (error: import('./errors.js').ClickClacksError) => void
  /**
   * Called when the API accepted items but reported `warnings` about them, for example a
   * group trait it dropped (`group_trait_dropped`). Default: `console.warn`.
   */
  onWarning?: (warnings: ItemWarning[]) => void
  /** Replaces the global `fetch`, for proxies and tests. */
  fetch?: FetchLike
}

export interface ShutdownOptions {
  /** Milliseconds to keep delivering before giving up. Default 10,000. */
  timeout?: number
}

/** A per-item error from the API, with the item it belongs to. */
export interface ItemError {
  /** The item's index within the request that was sent. */
  index: number
  code: string
  field?: string
  message?: string
  /** The item's `insert_id`, to match the error to your own records. */
  insertId?: string
  /** The item's event name (`$identify` for identify items, `$group_identify` for group items). */
  event?: string
}

/** A per-item warning from the API: the item was accepted, with a change, such as a dropped trait. */
export interface ItemWarning {
  /** The item's index within the request that was sent. */
  index: number
  /** For example `group_trait_dropped`. */
  code: string
  /** For example `properties.email`. */
  field?: string
  message?: string
  /** The item's `insert_id`. */
  insertId?: string
  /** The item's event name. */
  event?: string
}
