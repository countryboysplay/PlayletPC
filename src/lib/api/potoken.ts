/**
 * PoToken store.
 *
 * A PoToken is YouTube's proof that a real client is asking. It matters here for one
 * concrete reason: without one, googlevideo serves only ~20MB of any single format
 * before answering 403 forever, which ends playback after about five seconds at 4K.
 * With one, the TVHTML5 client is usable and that cap does not apply.
 *
 * Tokens are bound to an identity - the `visitorData` string - exactly as upstream
 * Playlet stores them (`PoTokens.bs`: `{ identity: { token, expiresAt, mintedAt } }`).
 * They are cached across launches because minting is slow and rate-sensitive.
 */

import { storage } from '../stores/storage'

export interface PoTokenEntry {
    token: string
    /** Unix seconds. */
    expiresAt: number
    mintedAt: number
}

const STORAGE_KEY = 'potokens'

/** Re-mint before expiry rather than at it, so playback never starts on a dying token. */
const REFRESH_MARGIN_SECONDS = 5 * 60

type Minter = (visitorData: string) => Promise<{ token: string; expiresAtUnix: number }>

let minter: Minter | null = null

/** Installed by the desktop shell once a minting environment is available. */
export function setPoTokenMinter(fn: Minter): void {
    minter = fn
}

export function isPoTokenMintingAvailable(): boolean {
    return minter !== null
}

function isUsable(entry: PoTokenEntry | undefined): entry is PoTokenEntry {
    if (!entry || !entry.token) return false
    return Math.floor(Date.now() / 1000) + REFRESH_MARGIN_SECONDS < entry.expiresAt
}

async function readAll(): Promise<Record<string, PoTokenEntry>> {
    return (await storage.get<Record<string, PoTokenEntry>>(STORAGE_KEY)) ?? {}
}

/** Drop expired entries so the store does not accumulate dead tokens. */
async function writeEntry(identity: string, entry: PoTokenEntry): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    const all = await readAll()
    const pruned: Record<string, PoTokenEntry> = {}
    for (const [key, value] of Object.entries(all)) {
        if (value && value.expiresAt > now) pruned[key] = value
    }
    pruned[identity] = entry
    await storage.set(STORAGE_KEY, pruned)
}

/** In-flight mints, so concurrent callers share one attempt per identity. */
const pending = new Map<string, Promise<string | null>>()

/**
 * Return a usable token for this identity, minting one if needed.
 *
 * Returns null when minting is unavailable or fails. Callers must treat that as
 * "carry on without a token" rather than an error: playback still works, just with
 * the 20MB cap, so a failed mint must never block watching a short video.
 */
export async function getPoToken(visitorData: string): Promise<string | null> {
    if (!visitorData) return null

    const cached = (await readAll())[visitorData]
    if (isUsable(cached)) return cached.token

    if (!minter) return null

    const existing = pending.get(visitorData)
    if (existing) return existing

    const attempt = (async () => {
        try {
            const minted = await minter!(visitorData)
            if (!minted?.token) return null
            await writeEntry(visitorData, {
                token: minted.token,
                expiresAt: minted.expiresAtUnix,
                mintedAt: Math.floor(Date.now() / 1000)
            })
            return minted.token
        } catch (err) {
            console.warn('[potoken] minting failed; falling back to the capped path', err)
            return null
        } finally {
            pending.delete(visitorData)
        }
    })()

    pending.set(visitorData, attempt)
    return attempt
}

/** Forget a token the server rejected, so the next attempt re-mints. */
export async function invalidatePoToken(visitorData: string): Promise<void> {
    const all = await readAll()
    delete all[visitorData]
    await storage.set(STORAGE_KEY, all)
}

/**
 * Stream URLs must carry the token too - the player response alone is not enough.
 * Appending it to an already-proxied URL would corrupt the wrapper, so this is applied
 * to the raw googlevideo URL before proxying.
 */
export function appendPoTokenToStreamUrl(url: string, token: string | null): string {
    if (!token || !url) return url
    if (url.includes('&pot=') || url.includes('?pot=')) return url
    return url + (url.includes('?') ? '&' : '?') + 'pot=' + encodeURIComponent(token)
}
