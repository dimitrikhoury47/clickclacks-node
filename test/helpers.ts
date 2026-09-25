import { gunzipSync } from 'node:zlib'
import type { ClickClacksError, ClickClacksOptions, FetchLike } from '../src/index.js'
import { ClickClacks } from '../src/index.js'

export const KEY = 'cks_live_testkey000000000000000000000000000000000'

export interface CapturedRequest {
  url: string
  headers: Record<string, string>
  /** The decoded JSON body. */
  json: { items: Record<string, unknown>[] }
  /** The body exactly as sent. */
  raw: string | Uint8Array
  at: number
}

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error | 'hang'

export function accepted(count: number, extra: Record<string, unknown> = {}): Reply {
  return { status: 202, body: { accepted: count, dropped: [], errors: [], request_id: 'req-test', ...extra } }
}

export function decodeBody(headers: Record<string, string>, raw: string | Uint8Array): string {
  if (headers['Content-Encoding'] === 'gzip') return gunzipSync(raw as Uint8Array).toString('utf8')
  return raw as string
}

/**
 * A scripted fake of the API. Replies are used in order; after they run out, every request
 * gets a 202 that accepts all items.
 */
export function mockApi(replies: Reply[] | ((request: CapturedRequest, n: number) => Reply) = []) {
  const requests: CapturedRequest[] = []
  const fetch: FetchLike = async (url, init) => {
    const text = decodeBody(init.headers, init.body)
    const request: CapturedRequest = {
      url,
      headers: init.headers,
      json: JSON.parse(text),
      raw: init.body,
      at: Date.now(),
    }
    requests.push(request)
    const n = requests.length - 1
    const reply: Reply =
      typeof replies === 'function' ? replies(request, n) : (replies[n] ?? accepted(request.json.items.length))
    if (reply === 'hang') {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')))
      })
    }
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    })
  }
  return { fetch, requests }
}

export function makeClient(options: Partial<ClickClacksOptions> & { fetch: FetchLike }) {
  const errors: ClickClacksError[] = []
  const client = new ClickClacks({
    key: KEY,
    flushInterval: 0,
    onError: (error) => errors.push(error),
    ...options,
  })
  return { client, errors }
}
