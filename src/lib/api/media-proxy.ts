/**
 * URL rewriting for the media proxy.
 *
 * googlevideo sends `Access-Control-Allow-Origin` only for `https://www.youtube.com`.
 * A `<video src>` does not care, but MSE does - shaka fetches DASH segments with
 * fetch/XHR - so adaptive playback needs the bytes to arrive from an origin that does
 * send CORS headers. The Rust side serves exactly that on a custom URI scheme.
 *
 * Rewriting is only correct for the direct YouTube backend. Invidious already hands
 * back URLs the app is allowed to fetch, and double-proxying them would break them.
 */

/** Windows resolves a Tauri custom scheme to `http://<scheme>.localhost`. */
const PROXY_ORIGIN = 'http://playletmedia.localhost'

const PROXYABLE_HOST = /(^|\.)(googlevideo\.com|ytimg\.com|ggpht\.com|youtube\.com)$/i

/** True when the URL points at YouTube media the Rust proxy is willing to fetch. */
export function isProxyableMediaUrl(url: string): boolean {
    try {
        return PROXYABLE_HOST.test(new URL(url).hostname)
    } catch {
        return false
    }
}

/**
 * Route a media URL through the app's own process.
 *
 * The target is passed as a query parameter rather than spliced into the path, so its
 * own query string (which carries the expiry and signature) survives intact.
 *
 * `videoId` matters: a stream URL can expire mid-playback, after which googlevideo
 * answers 403 to every further range. Knowing the video lets the proxy mint a
 * replacement URL for the same format and retry, invisibly to the player.
 *
 * There is no "20MB budget", whatever this comment used to say - that number was
 * simply where one particular itag happened to stop. What the refresh must never do
 * is reach for a client whose URLs are capped; see `media.rs::refresh_stream_url`.
 */
export function proxyMediaUrl(url: string, videoId?: string): string {
    if (!url) return url
    if (url.startsWith(PROXY_ORIGIN)) return url
    if (!isProxyableMediaUrl(url)) return url
    const target = PROXY_ORIGIN + '/?u=' + encodeURIComponent(url)
    return videoId ? target + '&v=' + encodeURIComponent(videoId) : target
}

/** Undo the rewrite, for logging and diagnostics. */
export function unproxyMediaUrl(url: string): string {
    if (!url.startsWith(PROXY_ORIGIN)) return url
    try {
        const target = new URL(url).searchParams.get('u')
        return target ?? url
    } catch {
        return url
    }
}
