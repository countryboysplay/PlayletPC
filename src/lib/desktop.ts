/**
 * Binds the app's abstraction seams to the Tauri shell.
 *
 * Nothing else in `src/` imports `@tauri-apps/*`. Every desktop capability reaches the
 * UI through the transport / storage / shell facades, so the app still runs in a plain
 * browser during development and could be re-hosted on a different shell without
 * touching a component.
 */

import { HttpError, setTransport, transportFetch, type HttpRequest, type HttpResponse, type Transport } from './api/http'
import { setStorageBackend, type StorageBackend } from './stores/storage'
import { setShellBackend, type ShellBackend } from './shell'
import { configureHttp } from './player'
import { setInnertubeInvoke } from './api/innertube'
import { setAccountInvoke } from './stores/account.svelte'

interface ApiResponsePayload {
  status: number
  ok: boolean
  url: string
  headers: Record<string, string>
  body: string
  elapsedMs: number
}

/** True when running inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * All JSON goes through Rust.
 *
 * Public Invidious instances have inconsistent CORS headers and the user picks which
 * one to use at runtime, so browser `fetch` would work on some instances and fail on
 * others with an error the app cannot distinguish from the host being down. The Rust
 * client sends no Origin and does no preflight, so instance choice stops being a
 * CORS gamble.
 *
 * Media (img/video/audio elements) deliberately does NOT come through here - see
 * media.ts.
 */
function createTauriTransport(invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>): Transport {
  return {
    name: 'tauri',
    async request(req: HttpRequest): Promise<HttpResponse> {
      try {
        const res = await invoke<ApiResponsePayload>('api_fetch', {
          req: {
            url: req.url,
            method: req.method ?? 'GET',
            headers: req.headers ?? {},
            body: typeof req.body === 'string' ? req.body : req.body === undefined ? undefined : JSON.stringify(req.body),
            timeoutMs: req.timeoutMs
          }
        })
        return { status: res.status, ok: res.ok, body: res.body, headers: res.headers }
      } catch (err) {
        const message = String(err)
        // The Rust side rejects with a plain string; map the known refusals onto typed errors.
        if (message.includes('host not allowed') || message.includes('blocked')) {
          throw new HttpError('client', req.url, message)
        }
        if (message.includes('timed out') || message.includes('timeout')) {
          throw new HttpError('timeout', req.url, message)
        }
        throw new HttpError('network', req.url, message)
      }
    }
  }
}

/**
 * The Rust allowlist is runtime state, so any instance the app may talk to has to be
 * registered before the first request to it. Called on startup and whenever the
 * instance list changes.
 */
let registerHosts: ((hosts: string[]) => Promise<void>) | null = null

export async function allowHosts(hosts: string[]): Promise<void> {
  if (!registerHosts) return
  await registerHosts(hosts.filter(Boolean))
}

export async function initDesktop(): Promise<void> {
  if (!isTauri()) {
    // In the browser dev server the player can use the native fetch directly.
    return
  }

  const [{ invoke }, store, windowApi, opener] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/plugin-store'),
    import('@tauri-apps/api/window'),
    import('@tauri-apps/plugin-opener')
  ])

  setTransport(createTauriTransport(invoke))

  // Video metadata and captions follow the same CORS-free path as the rest of the API.
  // Media segments deliberately do not: see transportFetch.
  configureHttp({ fetchImpl: transportFetch })

  // The direct YouTube backend needs per-client headers the generic transport refuses
  // to send, so it talks to its own Rust command.
  setInnertubeInvoke(invoke)

  // Sign-in talks to YouTube's OAuth endpoints from Rust, where there is no CORS.
  setAccountInvoke(invoke)

  registerHosts = async (hosts: string[]) => {
    await invoke('set_allowed_hosts', { hosts })
  }

  // Settings live in a real file under AppData, not in webview storage that a
  // cache clear would wipe.
  const settingsStore = await store.load('settings.json', { autoSave: true })
  const tauriStorage: StorageBackend = {
    name: 'tauri-store',
    async get<T>(key: string) {
      return (await settingsStore.get<T>(key)) ?? undefined
    },
    async set(key: string, value: unknown) {
      await settingsStore.set(key, value)
    },
    async delete(key: string) {
      await settingsStore.delete(key)
    },
    async clear() {
      await settingsStore.clear()
    }
  }
  setStorageBackend(tauriStorage)

  const appWindow = windowApi.getCurrentWindow()
  const tauriShell: ShellBackend = {
    name: 'tauri',
    minimize: () => appWindow.minimize(),
    toggleMaximize: () => appWindow.toggleMaximize(),
    close: () => appWindow.close(),
    openExternal: (url: string) => opener.openUrl(url),
    async preventSleep() {
      await invoke('set_playback_state', { playing: true, video: true })
      return () => {
        void invoke('set_playback_state', { playing: false, video: true })
      }
    },
    setFullscreen: (active: boolean) => appWindow.setFullscreen(active)
  }
  setShellBackend(tauriShell)

  await invoke('app_ready')
}
