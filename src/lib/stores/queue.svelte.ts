/**
 * The up-next queue. In memory only, by the owner's decision: it starts empty each launch.
 *
 * Next (autoplay, the Windows flyout, the media key) takes from the queue before falling
 * back to recommendations. `played` is what Previous walks back through.
 */

import type { VideoSummary } from '../api/types'

class QueueStore {
  items = $state<VideoSummary[]>([])
  private played = $state<string[]>([])

  add(video: VideoSummary): void {
    this.items = [...this.items, video]
  }

  /** Put a video at the front, so it plays straight after the current one. */
  addNext(video: VideoSummary): void {
    this.items = [video, ...this.items]
  }

  remove(index: number): void {
    this.items = this.items.filter((_, i) => i !== index)
  }

  clear(): void {
    this.items = []
  }

  /** Leave `currentId` for the next video: the queue's first item, else `fallback`. */
  next(currentId: string, fallback?: VideoSummary): VideoSummary | undefined {
    // A queued copy of the video already playing would make Next go nowhere.
    const [head, ...rest] = this.items.filter((v) => v.videoId !== currentId)
    const next = head ?? fallback
    if (!next) return undefined
    if (head) this.items = rest
    this.played.push(currentId)
    return next
  }

  /** The video played before the current one, if any. */
  previous(): string | undefined {
    return this.played.pop()
  }

  get hasPrevious(): boolean {
    return this.played.length > 0
  }
}

export const queue = new QueueStore()
