/**
 * Transport-agnostic HTTP layer.
 *
 * The renderer must not care whether a request goes out via the webview's `fetch`
 * (subject to CORS) or is proxied through the desktop shell's native HTTP stack
 * (not subject to CORS). The shell installs its transport at startup via
 * `setTransport`; in a plain browser dev server the fetch transport is used.
 */

export type HttpMethod = 'GET' | 'POST' | 'DELETE' | 'PATCH'

export interface HttpRequest {
  url: string
  method?: HttpMethod
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

export interface HttpResponse {
  status: number
  ok: boolean
  body: string
  headers: Record<string, string>
}

export interface Transport {
  readonly name: string
  request(req: HttpRequest): Promise<HttpResponse>
}

/** Typed failures so callers can distinguish "this instance is bad" from "this video is gone". */
export type HttpErrorKind =
  | 'network'      // DNS failure, connection refused, TLS error - instance likely down
  | 'timeout'
  | 'cors'         // blocked by the webview - needs the native transport
  | 'not_found'    // 404 - the resource, not the instance, is the problem
  | 'rate_limited' // 429
  | 'server'       // 5xx - instance is unhealthy
  | 'client'       // other 4xx
  | 'parse'        // response was not the JSON we expected
  | 'aborted'

export class HttpError extends Error {
  readonly kind: HttpErrorKind
  readonly status?: number
  readonly url: string
  /** True when the fault is attributable to the instance rather than the request. */
  readonly instanceFault: boolean

  constructor(kind: HttpErrorKind, url: string, message: string, status?: number) {
    super(message)
    this.name = 'HttpError'
    this.kind = kind
    this.url = url
    this.status = status
    this.instanceFault = kind === 'network' || kind === 'timeout' || kind === 'server' || kind === 'cors'
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Browser/webview transport. Subject to CORS - fine for dev and for CORS-enabled instances. */
export const fetchTransport: Transport = {
  name: 'fetch',
  async request(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController()
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs)
    if (req.signal) {
      if (req.signal.aborted) controller.abort()
      else req.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      const res = await fetch(req.url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
        redirect: 'follow'
      })
      const headers: Record<string, string> = {}
      res.headers.forEach((v, k) => { headers[k] = v })
      return { status: res.status, ok: res.ok, body: await res.text(), headers }
    } catch (err) {
      const e = err as Error
      if (e.name === 'TimeoutError') throw new HttpError('timeout', req.url, `Request timed out after ${timeoutMs}ms`)
      if (e.name === 'AbortError') throw new HttpError('aborted', req.url, 'Request aborted')
      // A CORS rejection is indistinguishable from a network failure in the fetch API.
      // Treat it as CORS so the caller can retry over the native transport.
      throw new HttpError('cors', req.url, `Request failed (network or CORS): ${e.message}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

let active: Transport = fetchTransport

export function setTransport(t: Transport): void { active = t }
export function getTransport(): Transport { return active }

function statusToKind(status: number): HttpErrorKind {
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server'
  return 'client'
}

/** Issue a request and parse JSON, mapping every failure onto HttpError. */
export async function requestJson<T>(req: HttpRequest): Promise<T> {
  const res = await active.request(req)
  if (!res.ok) {
    throw new HttpError(statusToKind(res.status), req.url, `HTTP ${res.status} from ${req.url}`, res.status)
  }
  try {
    return JSON.parse(res.body) as T
  } catch {
    const preview = res.body.slice(0, 120).replace(/\s+/g, ' ')
    throw new HttpError('parse', req.url, `Expected JSON, got: ${preview}`, res.status)
  }
}

/**
 * A `fetch`-shaped view of the active transport, for libraries that expect one.
 *
 * Text only. The native transport decodes bodies as UTF-8, so binary payloads
 * (media segments) must never be requested through this.
 */
export function transportFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {}
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value
    })
  }
  return active
    .request({
      url: input,
      method: (init?.method as HttpMethod) ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined
    })
    .then(res => new Response(res.body, { status: res.status, headers: res.headers }))
}

/** Build a URL with query params, dropping undefined/null and encoding arrays as comma-separated. */
export function buildUrl(base: string, path: string, query?: Record<string, unknown>): string {
  const root = base.replace(/\/+$/, '')
  const url = new URL(root + path)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v))
    }
  }
  return url.toString()
}
