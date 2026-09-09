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
 *   ANDROID_VR   Usually LOGIN_REQUIRED right now, but cheap to try.
 *   TVHTML5      What the upstream Roku app uses. Works from Roku hardware.
 *   WEB_EMBEDDED Last resort.
 *
 * IOS is deliberately absent. It answers OK and returns direct URLs, so every cheap
 * check calls it healthy - and then YouTube stops serving it at exactly 60.000s of
 * media. In a fallback ladder that is worse than an outright failure: playback runs
 * ~18-20 seconds (the forward buffer eats the rest of the minute) and silently
 * freezes, which reads as a player bug and hides the real cause.
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
