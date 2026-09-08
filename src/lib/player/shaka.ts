/**
 * shaka.ts - lazily loaded, structurally typed facade over shaka-player.
 *
 * Why a facade instead of importing shaka's own d.ts everywhere:
 *  - shaka-player is ~400KB gzipped; it should not be in the app's first chunk.
 *    A dynamic import keeps startup fast and lets the app run (progressive
 *    fallback only) even if the bundle fails to load.
 *  - shaka's generated typings churn between minor versions. Declaring only the
 *    surface we use means a shaka upgrade cannot break compilation of the app.
 *
 * If you prefer the real typings, delete the interfaces below and
 * `import shaka from 'shaka-player/dist/shaka-player.compiled'` - the call sites
 * are unchanged.
 */

export interface ShakaTrack {
  id: number;
  type: string; // 'variant' | 'text'
  active: boolean;
  bandwidth: number;
  language: string;
  label: string | null;
  kind?: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  codecs: string | null;
  mimeType: string | null;
  audioId?: number | null;
  videoId?: number | null;
}

export interface ShakaEventLike {
  type: string;
  detail?: unknown;
  buffering?: boolean;
  newTrack?: ShakaTrack;
}

export interface ShakaRequest {
  uris: string[];
  method: string;
  headers: Record<string, string>;
  allowCrossSiteCredentials?: boolean;
  retryParameters?: Record<string, unknown>;
  body?: ArrayBuffer | ArrayBufferView | null;
}

export interface ShakaResponse {
  uri: string;
  originalUri: string;
  data: ArrayBuffer;
  headers: Record<string, string>;
  status?: number;
  fromCache?: boolean;
}

export type RequestFilter = (type: number, request: ShakaRequest) => void | Promise<void>;
export type ResponseFilter = (type: number, response: ShakaResponse) => void | Promise<void>;

export interface ShakaNetworkingEngine {
  registerRequestFilter(filter: RequestFilter): void;
  registerResponseFilter(filter: ResponseFilter): void;
  unregisterRequestFilter(filter: RequestFilter): void;
  unregisterResponseFilter(filter: ResponseFilter): void;
}

export interface ShakaPlayerInstance {
  attach(el: HTMLMediaElement, initializeMediaSource?: boolean): Promise<void>;
  detach(): Promise<void>;
  load(uri: string, startTime?: number | null, mimeType?: string): Promise<void>;
  unload(initializeMediaSource?: boolean): Promise<void>;
  destroy(): Promise<void>;
  configure(config: Record<string, unknown>): boolean;
  getConfiguration(): Record<string, unknown>;
  getVariantTracks(): ShakaTrack[];
  selectVariantTrack(track: ShakaTrack, clearBuffer?: boolean, safeMargin?: number): void;
  getTextTracks(): ShakaTrack[];
  selectTextTrack(track: ShakaTrack): void;
  setTextTrackVisibility(on: boolean): Promise<void>;
  addTextTrackAsync(
    uri: string,
    language: string,
    kind: string,
    mimeType?: string,
    codec?: string,
    label?: string,
  ): Promise<ShakaTrack>;
  isLive(): boolean;
  isBuffering(): boolean;
  seekRange(): { start: number; end: number };
  getStats(): Record<string, unknown>;
  getNetworkingEngine(): ShakaNetworkingEngine | null;
  addEventListener(type: string, listener: (e: ShakaEventLike) => void): void;
  removeEventListener(type: string, listener: (e: ShakaEventLike) => void): void;
  getLoadMode?(): number;
}

export interface ShakaNamespace {
  Player: {
    new (mediaElement?: HTMLMediaElement | null): ShakaPlayerInstance;
    isBrowserSupported(): boolean;
  };
  polyfill: { installAll(): void };
  net?: {
    NetworkingEngine?: {
      RequestType?: Record<string, number>;
    };
  };
  log?: { setLevel(level: number): void; Level?: Record<string, number> };
}

/** shaka.net.NetworkingEngine.RequestType values (stable across versions). */
export const RequestType = {
  MANIFEST: 0,
  SEGMENT: 1,
  LICENSE: 2,
  APP: 3,
  TIMING: 4,
  SERVER_CERTIFICATE: 5,
  KEY: 6,
} as const;

let shakaPromise: Promise<ShakaNamespace> | null = null;

/**
 * Load and initialise shaka once. Resolves to null if it cannot be loaded or
 * the engine is unsupported - callers then degrade to the progressive path.
 */
export async function loadShaka(): Promise<ShakaNamespace | null> {
  if (!shakaPromise) {
    shakaPromise = import('shaka-player/dist/shaka-player.compiled.js').then((mod) => {
      const ns = ((mod as unknown as { default?: unknown }).default ?? mod) as ShakaNamespace;
      ns.polyfill.installAll();
      return ns;
    });
  }
  try {
    const ns = await shakaPromise;
    if (!ns.Player.isBrowserSupported()) return null;
    return ns;
  } catch {
    shakaPromise = null;
    return null;
  }
}

/** Allows tests (or an Electron build using a different bundle path) to inject. */
export function __setShakaForTesting(ns: ShakaNamespace | null): void {
  shakaPromise = ns ? Promise.resolve(ns) : null;
}
