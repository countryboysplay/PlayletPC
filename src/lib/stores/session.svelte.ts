/**
 * Session state: owns the live backend and the app's connection status.
 *
 * Two backends satisfy the same contract:
 *   'playlet'   - direct YouTube (InnerTube). The default, and the only one that
 *                 reliably serves video: no instance to pick, nothing to go down.
 *   'invidious' - a public or self-hosted Invidious instance, with health probing
 *                 and automatic failover, since public instances fail constantly.
 */

import type { Backend, BackendKind } from '../api/backend'
import { InvidiousClient } from '../api/invidious'
import { InnertubeClient, isInnertubeAvailable } from '../api/innertube'
import { FALLBACK_INSTANCES, resolveWorkingInstance, type HealthResult } from '../api/instances'
import { allowHosts } from '../desktop'
import { settings } from './settings.svelte'
import { account } from './account.svelte'
import { library } from './library.svelte'
import type { PlaylistSummary } from '../api/types'

export type ConnectionStatus = 'starting' | 'connecting' | 'ready' | 'offline'

class Session {
  status = $state<ConnectionStatus>('starting')
  /** Instances probed during the last connection attempt, for the settings screen. */
  lastProbe = $state<HealthResult[]>([])
  /** Set when the app had to move off the user's configured instance. */
  failedOverFrom = $state<string | null>(null)
  /** Set when the requested backend was unavailable and the app fell back. */
  backendNotice = $state<string | null>(null)

  /** Playlists saved on the signed-in YouTube account; empty when signed out. */
  accountPlaylists = $state<PlaylistSummary[]>([])
  accountSyncing = $state(false)
  accountSyncError = $state<string | null>(null)
  /** How many subscriptions the last sync added that were not already local. */
  accountSubsAdded = $state(0)
  private accountSyncedAt: number | null = null

  private client: Backend | null = null

  get api(): Backend {
    if (!this.client) throw new Error('Backend used before the session was ready')
    return this.client
  }

  get kind(): BackendKind {
    return this.client?.kind ?? 'playlet'
  }

  get instance(): string {
    return this.client?.instance ?? ''
  }

  get isReady(): boolean {
    return this.status === 'ready' && this.client !== null
  }

  /** True when media URLs are already directly playable and must not be proxied. */
  get isDirect(): boolean {
    return this.kind === 'playlet'
  }

  /** Resolve a backend and build the client. Safe to call again to retry. */
  async connect(): Promise<void> {
    this.status = 'connecting'
    this.failedOverFrom = null
    this.backendNotice = null

    const requested = settings.backend

    if (requested === 'playlet') {
      if (isInnertubeAvailable()) {
        const client = new InnertubeClient()
        client.disableAutoDubbed = settings.disableAutoDubbed
        this.client = client
        this.status = 'ready'
        return
      }
      // The direct backend needs the desktop shell's native transport; in a plain
      // browser dev server it cannot work, so fall through to Invidious.
      this.backendNotice = 'Direct YouTube needs the desktop app, so Playlet is using an Invidious instance.'
    }

    await this.connectInvidious()
  }

  private async connectInvidious(): Promise<void> {
    const preferred = settings.instance || undefined

    // The shell's network allowlist is runtime state: every instance the app might
    // probe has to be registered before the first request reaches it.
    await allowHosts([...(preferred ? [preferred] : []), ...FALLBACK_INSTANCES])

    const { instance, checked } = await resolveWorkingInstance(preferred, undefined, allowHosts)
    this.lastProbe = checked

    if (!instance) {
      this.status = 'offline'
      return
    }

    if (preferred && instance !== preferred) {
      this.failedOverFrom = preferred
    }

    this.client = new InvidiousClient({
      instance,
      proxyVideos: settings.proxyVideos,
      region: navigator.language.split('-')[1] || 'US'
    })

    if (instance !== settings.instance) {
      await settings.set('invidious.instance', instance)
    }

    this.status = 'ready'
  }

  /** Switch backend at runtime from the settings screen. */
  async useBackend(kind: BackendKind): Promise<void> {
    await settings.set('backend.selected', kind)
    this.client = null
    await this.connect()
  }

  /**
   * Pull the signed-in account's subscriptions and playlists into the app.
   *
   * Subscriptions are MERGED into the local library rather than replacing it, so the
   * existing Subscriptions page, the Home feed and the channel "Subscribed" state all
   * light up without any of them needing to know an account exists. Playlists are held
   * here because there is no local equivalent to merge them into.
   *
   * Only the direct YouTube backend can do this - the account token is a YouTube
   * token, and Invidious has its own separate account model. Failure is non-fatal and
   * never blocks startup: a signed-in user with a dead network still gets their local
   * library.
   */
  async syncAccount(opts: { force?: boolean } = {}): Promise<void> {
    const client = this.client
    if (!(client instanceof InnertubeClient) || !account.isSignedIn) {
      this.accountPlaylists = []
      return
    }
    if (this.accountSyncing) return
    if (this.accountSyncedAt !== null && !opts.force) return

    this.accountSyncing = true
    this.accountSyncError = null
    try {
      const [channels, playlists] = await Promise.all([
        client.subscribedChannels(),
        client.savedPlaylists()
      ])
      if (channels.length > 0) {
        this.accountSubsAdded = await library.mergeSubscriptions(
          channels.map(c => ({
            authorId: c.authorId,
            author: c.author,
            thumbnail: c.authorThumbnails.at(-1)?.url
          }))
        )
      }
      this.accountPlaylists = playlists
      this.accountSyncedAt = Date.now()
    } catch (err) {
      this.accountSyncError = String(err)
    } finally {
      this.accountSyncing = false
    }
  }

  /** Drop anything pulled from the account, e.g. after signing out. */
  clearAccountData(): void {
    this.accountPlaylists = []
    this.accountSyncedAt = null
    this.accountSubsAdded = 0
    this.accountSyncError = null
  }

  /** Switch to a specific Invidious instance chosen by the user. */
  async useInstance(instance: string): Promise<void> {
    await settings.set('invidious.instance', instance)
    await settings.set('backend.selected', 'invidious')

    const current = this.client
    if (current instanceof InvidiousClient) {
      current.setInstance(instance)
      this.failedOverFrom = null
      this.status = 'ready'
      return
    }
    this.client = null
    await this.connect()
  }
}

export const session = new Session()
