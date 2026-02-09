/**
 * Event system for the coding agent loop.
 * Provides a typed EventEmitter that delivers SessionEvent objects to listeners.
 */

import { EventKind, type SessionEvent } from './types.js';

export { EventKind };

export type EventListener = (event: SessionEvent) => void;

/**
 * EventEmitter delivers typed SessionEvent objects.
 * Supports per-kind listeners and wildcard ('*') listeners.
 */
export class EventEmitter {
  private _listeners = new Map<string, Set<EventListener>>();
  private _wildcardListeners = new Set<EventListener>();
  private _sessionId: string;
  private _buffer: SessionEvent[] = [];
  private _buffering = false;

  constructor(sessionId: string) {
    this._sessionId = sessionId;
  }

  /** Listen for a specific event kind */
  on(kind: EventKind | '*', listener: EventListener): () => void {
    if (kind === '*') {
      this._wildcardListeners.add(listener);
      return () => {
        this._wildcardListeners.delete(listener);
      };
    }
    let set = this._listeners.get(kind);
    if (!set) {
      set = new Set();
      this._listeners.set(kind, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  /** Remove a listener */
  off(kind: EventKind | '*', listener: EventListener): void {
    if (kind === '*') {
      this._wildcardListeners.delete(listener);
      return;
    }
    this._listeners.get(kind)?.delete(listener);
  }

  /** Emit an event */
  emit(kind: EventKind, data: Record<string, unknown> = {}): SessionEvent {
    const event: SessionEvent = {
      kind,
      timestamp: new Date(),
      session_id: this._sessionId,
      data,
    };

    if (this._buffering) {
      this._buffer.push(event);
      return event;
    }

    this._deliver(event);
    return event;
  }

  /** Enable buffering (events are queued, not delivered) */
  startBuffering(): void {
    this._buffering = true;
  }

  /** Flush buffered events and stop buffering */
  flush(): void {
    this._buffering = false;
    const events = this._buffer.splice(0);
    for (const event of events) {
      this._deliver(event);
    }
  }

  /** Remove all listeners */
  removeAllListeners(): void {
    this._listeners.clear();
    this._wildcardListeners.clear();
  }

  /**
   * Returns an async iterator that yields events.
   * Useful for host applications that consume events as an async stream.
   */
  asyncIterator(kinds?: EventKind[]): AsyncIterableIterator<SessionEvent> {
    const queue: SessionEvent[] = [];
    let resolve: ((value: IteratorResult<SessionEvent>) => void) | null = null;
    let done = false;

    const push = (event: SessionEvent) => {
      if (kinds && !kinds.includes(event.kind)) return;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };

    const unsub = this.on('*', push);

    const endListener = () => {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as unknown as SessionEvent, done: true });
      }
    };
    this.on(EventKind.SESSION_END, endListener);

    return {
      next(): Promise<IteratorResult<SessionEvent>> {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (done) {
          return Promise.resolve({
            value: undefined as unknown as SessionEvent,
            done: true,
          });
        }
        return new Promise((r) => {
          resolve = r;
        });
      },
      return(): Promise<IteratorResult<SessionEvent>> {
        unsub();
        done = true;
        return Promise.resolve({
          value: undefined as unknown as SessionEvent,
          done: true,
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  private _deliver(event: SessionEvent): void {
    const kindListeners = this._listeners.get(event.kind);
    if (kindListeners) {
      for (const listener of kindListeners) {
        listener(event);
      }
    }
    for (const listener of this._wildcardListeners) {
      listener(event);
    }
  }
}
