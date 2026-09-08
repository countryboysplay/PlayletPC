/**
 * Facade over desktop-shell capabilities.
 *
 * The UI calls these unconditionally. In a browser dev server they degrade to no-ops
 * so `npm run dev` stays usable; the desktop shell installs a real implementation at
 * startup. Keeping window controls behind this seam means no component imports Tauri
 * directly, which is what makes the Electron fallback a config change rather than a
 * rewrite.
 */

export interface ShellBackend {
  readonly name: string
  minimize(): void | Promise<void>
  toggleMaximize(): void | Promise<void>
  close(): void | Promise<void>
  /** Open a URL in the user's default browser rather than inside the app window. */
  openExternal(url: string): void | Promise<void>
  /** Keep the display awake during playback; returns a release function. */
  preventSleep(): Promise<() => void>
  setFullscreen(active: boolean): void | Promise<void>
}

const browserBackend: ShellBackend = {
  name: 'browser',
  minimize() {},
  toggleMaximize() {
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => {})
    else void document.exitFullscreen().catch(() => {})
  },
  close() {
    window.close()
  },
  openExternal(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  async preventSleep() {
    // The Screen Wake Lock API is the browser equivalent; it is not available everywhere.
    type WakeLockNavigator = Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> }
    }
    const nav = navigator as WakeLockNavigator
    if (!nav.wakeLock) return () => {}
    try {
      const sentinel = await nav.wakeLock.request('screen')
      return () => void sentinel.release().catch(() => {})
    } catch {
      return () => {}
    }
  },
  setFullscreen(active: boolean) {
    if (active) void document.documentElement.requestFullscreen().catch(() => {})
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  }
}

let backend: ShellBackend = browserBackend

export function setShellBackend(next: ShellBackend): void {
  backend = next
}

export const shell: ShellBackend = {
  get name() {
    return backend.name
  },
  minimize: () => backend.minimize(),
  toggleMaximize: () => backend.toggleMaximize(),
  close: () => backend.close(),
  openExternal: (url: string) => backend.openExternal(url),
  preventSleep: () => backend.preventSleep(),
  setFullscreen: (active: boolean) => backend.setFullscreen(active)
}

/** True when running inside the packaged desktop shell rather than a browser tab. */
export const isDesktop = (): boolean => backend.name !== 'browser'
