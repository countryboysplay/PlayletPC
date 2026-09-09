/**
 * Application settings.
 *
 * The schema is not redefined here - it is read from `data/preferences.json`, the same
 * file playlet-lib ships to the Roku app. Defaults, groupings, labels and allowed values
 * therefore match the original app, and the settings screen can render itself from the
 * schema rather than from hand-written form markup.
 */

import preferencesSchema from '../data/preferences.json'
import { DEFAULT_CATEGORY_OPTIONS } from '../api/sponsorblock'
import { storage } from './storage'

export type PreferenceType = 'boolean' | 'string' | 'number' | 'radio' | 'assocarray'

export interface PreferenceOption {
  displayText: string
  value: string
}

export interface PreferenceNode {
  displayText: string
  key: string
  description?: string
  type?: PreferenceType
  defaultValue?: unknown
  options?: PreferenceOption[]
  /** "tv" and "web" variants exist for the same key; the desktop app renders one row per key. */
  visibility?: 'tv' | 'web'
  rokuComponent?: string
  svelteComponent?: string
  children?: PreferenceNode[]
}

const schema = preferencesSchema as unknown as PreferenceNode[]

export interface PreferenceGroup {
  displayText: string
  key: string
  description?: string
  items: PreferenceNode[]
}

/**
 * Collapse the tv/web duplicate rows into one entry per key.
 *
 * The shipped schema lists some preferences twice: a "tv" row carrying the type and
 * defaultValue, and a "web" row naming a custom Svelte component. Merging them keeps
 * both the data (defaults) and the presentation hint (custom component).
 */
function mergeVariants(nodes: PreferenceNode[]): PreferenceNode[] {
  const byKey = new Map<string, PreferenceNode>()
  for (const node of nodes) {
    const existing = byKey.get(node.key)
    if (!existing) {
      byKey.set(node.key, { ...node })
      continue
    }
    byKey.set(node.key, {
      ...existing,
      ...node,
      // Never let a variant without a default erase the one that has it.
      type: existing.type ?? node.type,
      defaultValue: existing.defaultValue ?? node.defaultValue,
      options: existing.options ?? node.options,
      svelteComponent: existing.svelteComponent ?? node.svelteComponent
    })
  }
  return [...byKey.values()]
}

export const PREFERENCE_GROUPS: PreferenceGroup[] = schema.map(group => ({
  displayText: group.displayText,
  key: group.key,
  description: group.description,
  items: mergeVariants(group.children ?? [])
}))

/** Flat key -> default value map derived from the schema. */
function collectDefaults(): Record<string, unknown> {
  const defaults: Record<string, unknown> = {}
  for (const group of PREFERENCE_GROUPS) {
    for (const item of group.items) {
      if (item.defaultValue !== undefined) defaults[item.key] = item.defaultValue
    }
  }
  // The SponsorBlock category map is stored as one assocarray preference.
  if (defaults['sponsorblock.categories'] === undefined) {
    defaults['sponsorblock.categories'] = Object.fromEntries(
      Object.entries(DEFAULT_CATEGORY_OPTIONS).map(([category, option]) => [category, { option }])
    )
  }
  return defaults
}

export const DEFAULTS = collectDefaults()

const STORAGE_KEY = 'settings'

class SettingsStore {
  /** Reactive backing map: every read in a component re-runs when a value changes. */
  private values = $state<Record<string, unknown>>({ ...DEFAULTS })
  private loaded = $state(false)

  get ready(): boolean {
    return this.loaded
  }

  /** Load persisted values over the defaults. Unknown keys are kept so a downgrade is not destructive. */
  async load(): Promise<void> {
    const saved = await storage.get<Record<string, unknown>>(STORAGE_KEY)
    if (saved && typeof saved === 'object') {
      this.values = { ...DEFAULTS, ...saved }
    }
    this.loaded = true
  }

  get<T>(key: string): T {
    const value = this.values[key]
    return (value === undefined ? DEFAULTS[key] : value) as T
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values = { ...this.values, [key]: value }
    await this.persist()
  }

  async reset(key: string): Promise<void> {
    const next = { ...this.values }
    if (DEFAULTS[key] === undefined) delete next[key]
    else next[key] = DEFAULTS[key]
    this.values = next
    await this.persist()
  }

  async resetAll(): Promise<void> {
    this.values = { ...DEFAULTS }
    await this.persist()
  }

  snapshot(): Record<string, unknown> {
    return { ...this.values }
  }

  private async persist(): Promise<void> {
    await storage.set(STORAGE_KEY, this.snapshot())
  }

  // ---- Typed accessors for the settings this app reads on hot paths ----

  get autoplay(): boolean {
    return this.get<boolean>('playback.autoplay')
  }
  get preferredQuality(): string {
    return this.get<string>('playback.preferred_quality') ?? 'auto'
  }
  get disableAutoDubbed(): boolean {
    return this.get<boolean>('playback.disable_auto_dubbed')
  }
  get disableShorts(): boolean {
    return this.get<boolean>('content_feed.disable_shorts')
  }
  /**
   * The Invidious backend is disabled.
   *
   * The public instance network has largely stopped serving video - of 28 well-known
   * instances probed, one answered the API and then refused every video - so offering
   * it as a choice mostly produces confusing failures, and it muddies playback
   * debugging by adding a second code path that behaves differently.
   *
   * The client code is left in place. This getter is the single switch, so turning it
   * back on is a one-line change if the network recovers.
   */
  get backend(): 'playlet' | 'invidious' {
    return 'playlet'
  }
  get instance(): string {
    return this.get<string>('invidious.instance') ?? ''
  }
  get proxyVideos(): 'always' | 'if_needed' | 'never' {
    return this.get<'always' | 'if_needed' | 'never'>('invidious.proxy_videos') ?? 'if_needed'
  }
  get sponsorBlockEnabled(): boolean {
    return this.get<boolean>('sponsorblock.enabled')
  }
  get sponsorBlockNotifications(): boolean {
    return this.get<boolean>('sponsorblock.show_notifications')
  }
  get sponsorBlockCategories(): Record<string, { option: string }> {
    return this.get<Record<string, { option: string }>>('sponsorblock.categories') ?? {}
  }
  get searchHistoryEnabled(): boolean {
    return this.get<boolean>('search_history.enabled')
  }
}

export const settings = new SettingsStore()
