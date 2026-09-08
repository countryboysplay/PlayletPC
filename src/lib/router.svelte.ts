/**
 * Hash-based router with a navigation stack.
 *
 * Hash routing avoids needing a server rewrite rule when the app is loaded from the
 * filesystem in the packaged build. The explicit stack exists so Back behaves like a
 * media app rather than a browser: returning to a feed restores its scroll position,
 * and playing a video from a shelf then going back does not re-fetch the shelf.
 */

export type RouteName = 'home' | 'search' | 'watch' | 'channel' | 'playlist' | 'subscriptions' | 'history' | 'settings'

export interface Route {
  name: RouteName
  params: Record<string, string>
  /** Restored when navigating back to this entry. */
  scrollY?: number
}

function parseHash(hash: string): Route {
  const clean = hash.replace(/^#/, '') || '/'
  const [path, queryString] = clean.split('?')
  const query = new URLSearchParams(queryString ?? '')
  const params: Record<string, string> = {}
  query.forEach((value, key) => {
    params[key] = value
  })

  const segments = path.split('/').filter(Boolean)

  if (segments.length === 0) return { name: 'home', params }
  switch (segments[0]) {
    case 'search':
      return { name: 'search', params }
    case 'watch':
      return { name: 'watch', params }
    case 'channel':
      return { name: 'channel', params: { ...params, ucid: segments[1] ?? '' } }
    case 'playlist':
      return { name: 'playlist', params: { ...params, plid: segments[1] ?? '' } }
    case 'subscriptions':
      return { name: 'subscriptions', params }
    case 'history':
      return { name: 'history', params }
    case 'settings':
      return { name: 'settings', params }
    default:
      return { name: 'home', params }
  }
}

export function buildHash(name: RouteName, params: Record<string, string> = {}): string {
  const query = new URLSearchParams()
  let path: string

  switch (name) {
    case 'home':
      path = '/'
      break
    case 'channel':
      path = '/channel/' + encodeURIComponent(params.ucid ?? '')
      break
    case 'playlist':
      path = '/playlist/' + encodeURIComponent(params.plid ?? '')
      break
    default:
      path = '/' + name
  }

  for (const [key, value] of Object.entries(params)) {
    if (key === 'ucid' || key === 'plid') continue
    if (value === undefined || value === '') continue
    query.set(key, value)
  }

  const queryString = query.toString()
  return '#' + path + (queryString ? '?' + queryString : '')
}

class Router {
  current = $state<Route>(parseHash(location.hash))
  private stack = $state<Route[]>([])
  /** Set while restoring a previous entry, so the hashchange handler does not re-push it. */
  private navigatingBack = false

  constructor() {
    window.addEventListener('hashchange', () => {
      const next = parseHash(location.hash)
      if (!this.navigatingBack) {
        this.stack = [...this.stack, { ...this.current, scrollY: this.readScroll() }]
      }
      this.navigatingBack = false
      this.current = next
    })
  }

  get canGoBack(): boolean {
    return this.stack.length > 0
  }

  private readScroll(): number {
    const scroller = document.querySelector('[data-scroll-root]')
    return scroller instanceof HTMLElement ? scroller.scrollTop : 0
  }

  go(name: RouteName, params: Record<string, string> = {}): void {
    const target = buildHash(name, params)
    if (location.hash === target) return
    location.hash = target
  }

  /** Replace the current entry without growing the stack (e.g. refining a search). */
  replace(name: RouteName, params: Record<string, string> = {}): void {
    const target = buildHash(name, params)
    this.navigatingBack = true
    location.replace(location.pathname + location.search + target)
    this.current = parseHash(target)
  }

  back(): void {
    const previous = this.stack[this.stack.length - 1]
    if (!previous) return
    this.stack = this.stack.slice(0, -1)
    this.navigatingBack = true
    this.current = previous
    location.hash = buildHash(previous.name, previous.params)

    if (previous.scrollY) {
      // Wait for the restored view to render before putting the scroll position back.
      requestAnimationFrame(() => {
        const scroller = document.querySelector('[data-scroll-root]')
        if (scroller instanceof HTMLElement) scroller.scrollTop = previous.scrollY ?? 0
      })
    }
  }
}

export const router = new Router()
