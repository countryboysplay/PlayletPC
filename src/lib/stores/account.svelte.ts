/**
 * YouTube account (TV device sign-in).
 *
 * Signing in exists for a concrete reason: the TVHTML5 client refuses to play for a
 * signed-out session, and it is the client that is not limited to a ~60 second preview
 * per format. As a side effect it also unlocks the authenticated feeds - real
 * subscriptions, playlists, history, and a Home feed that is not empty.
 *
 * The refresh token is the sensitive part. It lives in the app's own data directory and
 * is never sent anywhere except YouTube's token endpoint.
 */

import { storage } from './storage'

export type SignInState = 'signed-out' | 'awaiting-code' | 'signed-in' | 'error'

interface StoredSession {
    refreshToken: string
    clientId: string
    clientSecret: string
    /** Cached access token, so a restart does not need a round trip. */
    accessToken?: string
    expiresAt?: number
}

interface DeviceCode {
    deviceCode: string
    userCode: string
    verificationUrl: string
    interval: number
    expiresIn: number
    clientId: string
    clientSecret: string
}

interface TokenResult {
    state: 'authorized' | 'pending' | 'slow_down' | 'expired' | 'denied' | 'revoked' | 'error'
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    error?: string
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

let invokeFn: Invoke | null = null

export function setAccountInvoke(fn: Invoke): void {
    invokeFn = fn
}

export function isSignInAvailable(): boolean {
    return invokeFn !== null
}

const STORAGE_KEY = 'youtube_account'

/** Refresh early; a token that expires mid-request looks like a random failure. */
const REFRESH_MARGIN_SECONDS = 120

class Account {
    state = $state<SignInState>('signed-out')
    /** The code the user types at the verification URL. */
    userCode = $state<string | null>(null)
    verificationUrl = $state<string>('https://www.google.com/device')
    message = $state<string | null>(null)

    private session: StoredSession | null = null
    private polling = false
    private cancelRequested = false

    get isSignedIn(): boolean {
        return this.state === 'signed-in'
    }

    /** Restore a previous sign-in. Safe to call before anything else. */
    async load(): Promise<void> {
        const saved = await storage.get<StoredSession>(STORAGE_KEY)
        if (saved?.refreshToken) {
            this.session = saved
            this.state = 'signed-in'
        }
    }

    /**
     * A valid access token, refreshing if needed. Returns null when signed out, which
     * callers must treat as "carry on anonymously" rather than an error.
     */
    async accessToken(): Promise<string | null> {
        if (!this.session || !invokeFn) return null

        const now = Math.floor(Date.now() / 1000)
        if (this.session.accessToken && (this.session.expiresAt ?? 0) > now + REFRESH_MARGIN_SECONDS) {
            return this.session.accessToken
        }

        try {
            const result = await invokeFn<TokenResult>('yt_oauth_refresh', {
                refreshToken: this.session.refreshToken,
                clientId: this.session.clientId,
                clientSecret: this.session.clientSecret
            })

            if (result.state === 'revoked') {
                // The user removed access from their Google account; stop pretending.
                await this.signOut()
                this.message = 'YouTube signed this device out. Sign in again to restore your account.'
                return null
            }
            if (!result.accessToken) return null

            this.session = {
                ...this.session,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken ?? this.session.refreshToken,
                expiresAt: result.expiresAt
            }
            await storage.set(STORAGE_KEY, this.session)
            return result.accessToken
        } catch (err) {
            console.warn('[account] token refresh failed', err)
            return null
        }
    }

    /**
     * Start sign-in and poll until the user approves.
     *
     * The loop lives here rather than in Rust so the code stays on screen, the interval
     * the server asks for is honoured, and the user can cancel.
     */
    async signIn(): Promise<void> {
        if (!invokeFn || this.polling) return

        this.polling = true
        this.cancelRequested = false
        this.message = null
        this.state = 'awaiting-code'

        try {
            const code = await invokeFn<DeviceCode>('yt_oauth_start')
            this.userCode = code.userCode
            this.verificationUrl = code.verificationUrl

            const deadline = Date.now() + code.expiresIn * 1000
            let intervalMs = Math.max(2, code.interval) * 1000

            while (Date.now() < deadline) {
                if (this.cancelRequested) {
                    this.reset()
                    return
                }
                await new Promise(resolve => setTimeout(resolve, intervalMs))

                const result = await invokeFn<TokenResult>('yt_oauth_poll', {
                    deviceCode: code.deviceCode,
                    clientId: code.clientId,
                    clientSecret: code.clientSecret
                })

                if (result.state === 'authorized' && result.refreshToken) {
                    this.session = {
                        refreshToken: result.refreshToken,
                        clientId: code.clientId,
                        clientSecret: code.clientSecret,
                        accessToken: result.accessToken,
                        expiresAt: result.expiresAt
                    }
                    await storage.set(STORAGE_KEY, this.session)
                    this.state = 'signed-in'
                    this.userCode = null
                    this.message = null
                    return
                }

                // The server asks us to back off rather than being told to stop.
                if (result.state === 'slow_down') intervalMs += 2000
                if (result.state === 'denied') {
                    this.reset()
                    this.message = 'Sign-in was declined.'
                    return
                }
                if (result.state === 'expired') {
                    this.reset()
                    this.message = 'That code expired. Start again to get a new one.'
                    return
                }
            }

            this.reset()
            this.message = 'That code expired. Start again to get a new one.'
        } catch (err) {
            this.state = 'error'
            this.userCode = null
            this.message = err instanceof Error ? err.message : String(err)
        } finally {
            this.polling = false
        }
    }

    cancel(): void {
        this.cancelRequested = true
    }

    async signOut(): Promise<void> {
        this.session = null
        this.reset()
        await storage.delete(STORAGE_KEY)
    }

    private reset(): void {
        this.state = this.session ? 'signed-in' : 'signed-out'
        this.userCode = null
    }
}

export const account = new Account()
