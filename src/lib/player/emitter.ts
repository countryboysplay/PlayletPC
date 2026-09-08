/**
 * emitter.ts - a tiny, dependency-free, strongly typed event emitter.
 *
 * Deliberately not EventTarget: we want typed payloads, synchronous dispatch,
 * and listener errors that cannot take the player down.
 */

export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

/**
 * `Events` is an interface mapping event name -> payload type. It is
 * deliberately unconstrained: a constraint of Record<string, unknown> would
 * reject plain interfaces (no index signature) and reject `void` payloads.
 */
export class TypedEmitter<Events> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();
  private onError: ((e: unknown, event: keyof Events) => void) | null = null;

  /** Called when a listener throws, so one bad subscriber cannot break playback. */
  setErrorHandler(fn: ((e: unknown, event: keyof Events) => void) | null): void {
    this.onError = fn;
  }

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as unknown as Listener<never>);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const wrapped: Listener<Events[K]> = (payload) => {
      this.off(event, wrapped);
      listener(payload);
    };
    return this.on(event, wrapped);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener as unknown as Listener<never>);
    if (set.size === 0) this.listeners.delete(event);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy first: listeners may unsubscribe (or subscribe) during dispatch.
    for (const listener of Array.from(set)) {
      try {
        (listener as unknown as Listener<Events[K]>)(payload);
      } catch (e) {
        if (this.onError) {
          try {
            this.onError(e, event);
          } catch {
            /* swallow */
          }
        }
      }
    }
  }

  listenerCount(event: keyof Events): number {
    const set = this.listeners.get(event);
    return set ? set.size : 0;
  }

  removeAll(event?: keyof Events): void {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }
}
