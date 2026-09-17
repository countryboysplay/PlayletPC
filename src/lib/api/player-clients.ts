/**
 * Which YouTube client serves playback.
 *
 * This is deliberately its own module with no dependencies: it is the single
 * statement of a policy that has been wrong twice, and it needs to be testable
 * without pulling in stores, runes or the Tauri bridge.
 *
 * What is measured, not assumed:
 *
 *   VISIONOS     Direct unciphered URLs, no `n`, no PoToken, and no serve limit.
 *                Verified across a whole 635s video - HTTP 206 with real media at
 *                1/25/50/75/95/99.9% of the file. Needs `X-Goog-Visitor-Id` or it
 *                answers LOGIN_REQUIRED. This is yt-dlp's default client.
 *   ANDROID_VR   LOGIN_REQUIRED as of 2026-09-17, but cheap to try.
 *   TVHTML5      What the upstream Roku app uses. Works from Roku hardware.
 *   WEB_EMBEDDED Last resort.
 *
 * Re-measured 2026-09-17 against live YouTube, on five videos:
 *
 *   visionos     OK, 27-28 formats, all direct URLs; media at 1/50/99% of the file
 *   android_vr   LOGIN_REQUIRED
 *   tv           LOGIN_REQUIRED
 *   web / mweb   UNPLAYABLE
 *
 * So VISIONOS is not merely the first rung - it is currently the ONLY rung that
 * serves media. The others are kept because they cost one request each and have
 * reopened before, but nothing below VISIONOS should be mistaken for a safety net.
 * That is why the visitor id now comes from a four-source cascade in
 * `innertube.rs::fetch_identity`: with one client working and one source for the
 * one header it requires, a single scrape failure took all playback down.
 *
 * IOS is deliberately absent, and is now worse than when that was decided. It used
 * to answer OK, hand over direct URLs, and then stop serving at exactly 60.000s -
 * bad enough, because playback ran ~18-20 seconds and froze, which reads as a
 * player bug. Measured 2026-09-17, its URLs now answer **HTTP 403 at every byte
 * offset, including 1%**: not capped any more, simply dead. Keep it out.
 */

export type PlayerClientName = 'visionos' | 'android_vr' | 'tv' | 'web_embedded'

export const PLAYER_CLIENT_LADDER: readonly PlayerClientName[] = [
  'visionos',
  'android_vr',
  'tv',
  'web_embedded'
] as const

/**
 * Sign-in state must NOT change the playback client.
 *
 * There used to be a separate signed-in ladder that tried `tv` first, on the theory
 * that an account token was what lifted the 60-second limit. It was not - VISIONOS
 * lifts it with no account at all - and the effect was that signed-in users had every
 * video freeze around 18 seconds while signed-out users were fine. Every automated
 * test runs signed out, so nothing caught it.
 *
 * Sign-in is for subscriptions and playlists. It has no say in playback.
 */
export const SIGNED_IN_LADDER: readonly PlayerClientName[] = PLAYER_CLIENT_LADDER

/** Clients known to serve only the first ~60 seconds. Never put these in a ladder. */
export const CAPPED_CLIENTS: readonly string[] = ['ios'] as const
