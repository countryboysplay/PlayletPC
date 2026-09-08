/**
 * Local library: subscriptions, watch history with resume positions, and search history.
 *
 * All of this is stored locally by design. The Roku app can optionally sync with an
 * Invidious account, but a user with no account still gets subscriptions and resume
 * points - the app is useful before you have logged into anything.
 */

import { storage } from './storage'

export interface Subscription {
  authorId: string
  author: string
  thumbnail?: string
  /** Epoch ms when the user subscribed, so the list can be sorted by recency. */
  addedAt: number
}

export interface WatchRecord {
  videoId: string
  title: string
  author: string
  authorId: string
  thumbnail?: string
  lengthSeconds: number
  /** Playback position in seconds, used to resume. */
  position: number
  /** Epoch ms of the most recent view. */
  watchedAt: number
  completed: boolean
}

const KEYS = {
  subscriptions: 'subscriptions',
  history: 'watch_history',
  searches: 'search_history'
}

/** Below this many seconds watched, a video is not worth recording as "in progress". */
const MIN_RESUME_SECONDS = 15
/** Within this many seconds of the end, treat the video as finished rather than resumable. */
const COMPLETION_TAIL_SECONDS = 20
const MAX_HISTORY = 500
const MAX_SEARCHES = 50

class LibraryStore {
  private subs = $state<Subscription[]>([])
  private watched = $state<WatchRecord[]>([])
  private searches = $state<string[]>([])
  private loaded = $state(false)

  get ready(): boolean {
    return this.loaded
  }
  get subscriptions(): Subscription[] {
    return this.subs
  }
  get history(): WatchRecord[] {
    return this.watched
  }
  get searchHistory(): string[] {
    return this.searches
  }

  async load(): Promise<void> {
    this.subs = (await storage.get<Subscription[]>(KEYS.subscriptions)) ?? []
    this.watched = (await storage.get<WatchRecord[]>(KEYS.history)) ?? []
    this.searches = (await storage.get<string[]>(KEYS.searches)) ?? []
    this.loaded = true
  }

  // ---- Subscriptions -----------------------------------------------------

  isSubscribed(authorId: string): boolean {
    return this.subs.some(s => s.authorId === authorId)
  }

  async subscribe(entry: Omit<Subscription, 'addedAt'>): Promise<void> {
    if (this.isSubscribed(entry.authorId)) return
    this.subs = [{ ...entry, addedAt: Date.now() }, ...this.subs]
    await storage.set(KEYS.subscriptions, this.subs)
  }

  async unsubscribe(authorId: string): Promise<void> {
    this.subs = this.subs.filter(s => s.authorId !== authorId)
    await storage.set(KEYS.subscriptions, this.subs)
  }

  async toggleSubscription(entry: Omit<Subscription, 'addedAt'>): Promise<boolean> {
    if (this.isSubscribed(entry.authorId)) {
      await this.unsubscribe(entry.authorId)
      return false
    }
    await this.subscribe(entry)
    return true
  }

  /** Replace the whole list, e.g. after importing from an Invidious account. */
  async replaceSubscriptions(list: Subscription[]): Promise<void> {
    this.subs = [...list]
    await storage.set(KEYS.subscriptions, this.subs)
  }

  // ---- Watch history -----------------------------------------------------

  getResumePosition(videoId: string): number {
    const record = this.watched.find(r => r.videoId === videoId)
    if (!record || record.completed) return 0
    return record.position >= MIN_RESUME_SECONDS ? record.position : 0
  }

  /**
   * Record progress for a video. Called on a throttle during playback, so this must be
   * cheap and must not rewrite history order on every tick beyond moving the entry to
   * the front.
   */
  async recordProgress(
    video: Omit<WatchRecord, 'position' | 'watchedAt' | 'completed'>,
    position: number
  ): Promise<void> {
    const remaining = video.lengthSeconds - position
    const completed = video.lengthSeconds > 0 && remaining <= COMPLETION_TAIL_SECONDS

    const record: WatchRecord = {
      ...video,
      position: completed ? 0 : position,
      watchedAt: Date.now(),
      completed
    }

    const rest = this.watched.filter(r => r.videoId !== video.videoId)
    this.watched = [record, ...rest].slice(0, MAX_HISTORY)
    await storage.set(KEYS.history, this.watched)
  }

  async removeFromHistory(videoId: string): Promise<void> {
    this.watched = this.watched.filter(r => r.videoId !== videoId)
    await storage.set(KEYS.history, this.watched)
  }

  async clearHistory(): Promise<void> {
    this.watched = []
    await storage.set(KEYS.history, this.watched)
  }

  /** Partially-watched videos, most recent first - the "Continue watching" row. */
  get continueWatching(): WatchRecord[] {
    return this.watched.filter(r => !r.completed && r.position >= MIN_RESUME_SECONDS)
  }

  // ---- Search history ----------------------------------------------------

  async recordSearch(query: string): Promise<void> {
    const trimmed = query.trim()
    if (!trimmed) return
    const rest = this.searches.filter(s => s.toLowerCase() !== trimmed.toLowerCase())
    this.searches = [trimmed, ...rest].slice(0, MAX_SEARCHES)
    await storage.set(KEYS.searches, this.searches)
  }

  async clearSearchHistory(): Promise<void> {
    this.searches = []
    await storage.set(KEYS.searches, this.searches)
  }

  /** Prefix matches from history, for the search box dropdown. */
  searchSuggestions(prefix: string, limit = 8): string[] {
    const needle = prefix.trim().toLowerCase()
    if (!needle) return this.searches.slice(0, limit)
    return this.searches.filter(s => s.toLowerCase().startsWith(needle)).slice(0, limit)
  }
}

export const library = new LibraryStore()
