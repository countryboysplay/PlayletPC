/**
 * tauri-net.ts - route ALL of shaka's HTTP through an injected fetch.
 *
 * This is the single highest-leverage integration in the whole layer.
 *
 * By default shaka fetches manifests and segments with the WebView's own
 * XHR/fetch, which means WebView2 applies CORS to every request. Your app runs
 * on tauri://localhost (or http://tauri.localhost on Windows), so every request
 * to an arbitrary Invidious instance is cross-origin. If that instance does not
 * send Access-Control-Allow-Origin - and plenty of hardened instances do not,
 * especially on /videoplayback - the stream is simply unplayable, with a
 * console error that looks nothing like the real cause.
 *
 * Registering a scheme plugin backed by Tauri's HTTP plugin (which performs the
 * request in Rust, outside the WebView's security context) makes CORS, preflight
 * and the Origin header disappear as a class of problem, and lets you set the
 * Referer/User-Agent that googlevideo is happier to serve.
 *
 * Usage:
 *   import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
 *   const shaka = await loadShaka();
 *   if (shaka) installFetchSchemePlugin(shaka, tauriFetch as unknown as FetchLike);
 *
 * Tauri v2 also needs the host allowed in capabilities, e.g.
 *   "permissions": [{ "identifier": "http:default",
 *                     "allow": [{ "url": "https://*" }] }]
 * Scope that down to your instance list plus *.googlevideo.com in production.
 */

import type { FetchLike } from './invidious';
import type { ShakaNamespace, ShakaRequest, ShakaResponse } from './shaka';

export interface SchemePluginOptions {
  /** Extra headers on every media request. Keep this minimal. */
  headers?: Record<string, string>;
  /** Schemes to take over. */
  schemes?: string[];
  /**
   * googlevideo rejects some requests without a plausible Referer. Setting it
   * is impossible from the WebView (forbidden header) but trivial in Rust.
   */
  referer?: string | null;
  userAgent?: string | null;
}

/** Minimal shape of shaka.util.AbortableOperation we rely on. */
interface AbortableOperationCtor {
  new (promise: Promise<ShakaResponse>, onAbort: () => Promise<void>): unknown;
}

interface ShakaWithNet extends ShakaNamespace {
  net?: {
    NetworkingEngine?: {
      RequestType?: Record<string, number>;
      registerScheme?: (
        scheme: string,
        plugin: (
          uri: string,
          request: ShakaRequest,
          requestType: number,
          progressUpdated?: (elapsedMs: number, bytes: number, remaining: number) => void,
          headersReceived?: (headers: Record<string, string>) => void,
        ) => unknown,
        priority?: number,
        progressSupport?: boolean,
      ) => void;
      unregisterScheme?: (scheme: string) => void;
      PluginPriority?: Record<string, number>;
    };
  };
  util?: {
    AbortableOperation?: AbortableOperationCtor;
  };
}

export function installFetchSchemePlugin(
  shaka: ShakaNamespace,
  fetchImpl: FetchLike,
  options: SchemePluginOptions = {},
): () => void {
  const ns = shaka as ShakaWithNet;
  const registerScheme = ns.net?.NetworkingEngine?.registerScheme;
  const unregisterScheme = ns.net?.NetworkingEngine?.unregisterScheme;
  const AbortableOperation = ns.util?.AbortableOperation;

  if (!registerScheme || !AbortableOperation) {
    // Non-fatal: we simply keep the WebView's own networking.
    console.warn('[player] shaka scheme registration unavailable; falling back to WebView networking (CORS applies).');
    return () => undefined;
  }

  const schemes = options.schemes ?? ['http', 'https'];
  // PluginPriority.PREFERRED = 3; beat the built-in http plugin.
  const priority = ns.net?.NetworkingEngine?.PluginPriority?.PREFERRED ?? 3;

  const plugin = (
    uri: string,
    request: ShakaRequest,
    _requestType: number,
    _progressUpdated?: (elapsedMs: number, bytes: number, remaining: number) => void,
    headersReceived?: (headers: Record<string, string>) => void,
  ): unknown => {
    const controller = new AbortController();
    const started = Date.now();

    const headers: Record<string, string> = { ...request.headers, ...(options.headers ?? {}) };
    if (options.referer) headers['Referer'] = options.referer;
    if (options.userAgent) headers['User-Agent'] = options.userAgent;

    const promise: Promise<ShakaResponse> = (async () => {
      const res = await fetchImpl(uri, {
        method: request.method || 'GET',
        headers,
        body: (request.body as BodyInit | null | undefined) ?? undefined,
        signal: controller.signal,
        redirect: 'follow',
      });

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value: string, key: string) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      if (headersReceived) headersReceived(responseHeaders);

      const data = await res.arrayBuffer();

      if (!res.ok) {
        // Throw a shaka-shaped error so errors.ts can classify it, and so
        // shaka's own retry logic treats it as a retryable bad status.
        throw {
          severity: 2,
          category: 1, // NETWORK
          code: 1001, // BAD_HTTP_STATUS
          data: [uri, res.status, data, responseHeaders, request.method, Date.now() - started],
        };
      }

      return {
        uri: res.url || uri,
        originalUri: uri,
        data,
        headers: responseHeaders,
        status: res.status,
        fromCache: responseHeaders['x-cache'] === 'HIT',
      } satisfies ShakaResponse;
    })();

    return new AbortableOperation(promise, () => {
      controller.abort();
      return Promise.resolve();
    });
  };

  for (const scheme of schemes) registerScheme(scheme, plugin, priority, true);

  return () => {
    if (!unregisterScheme) return;
    for (const scheme of schemes) unregisterScheme(scheme);
  };
}
