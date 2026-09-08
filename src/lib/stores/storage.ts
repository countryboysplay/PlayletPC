/**
 * Persistence abstraction.
 *
 * In the packaged desktop app this is backed by the shell's native store, so settings,
 * subscriptions and history live in the user's AppData directory and survive reinstalls
 * of the web assets. In a browser dev server it falls back to localStorage, which keeps
 * `npm run dev` usable without the desktop shell running.
 */

export interface StorageBackend {
  readonly name: string
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
}

const PREFIX = 'playlet:'

const localStorageBackend: StorageBackend = {
  name: 'localStorage',
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = localStorage.getItem(PREFIX + key)
      return raw === null ? undefined : (JSON.parse(raw) as T)
    } catch {
      // Corrupt entry: treat as absent rather than breaking startup.
      return undefined
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value))
    } catch (err) {
      console.warn('[storage] write failed for', key, err)
    }
  },
  async delete(key: string): Promise<void> {
    localStorage.removeItem(PREFIX + key)
  },
  async clear(): Promise<void> {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key)
    }
  }
}

let backend: StorageBackend = localStorageBackend

/** Installed by the desktop shell at startup to switch to native persistence. */
export function setStorageBackend(next: StorageBackend): void {
  backend = next
}

export const storage: StorageBackend = {
  get name() {
    return backend.name
  },
  get: <T>(key: string) => backend.get<T>(key),
  set: (key: string, value: unknown) => backend.set(key, value),
  delete: (key: string) => backend.delete(key),
  clear: () => backend.clear()
}
