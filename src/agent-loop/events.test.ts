import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from './events.js';
import { EventKind } from './types.js';

describe('EventEmitter', () => {
  it('on/emit: delivers event to registered listener', () => {
    const em = new EventEmitter('sess-1');
    const listener = vi.fn();
    em.on(EventKind.USER_INPUT, listener);
    em.emit(EventKind.USER_INPUT, { content: 'hello' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      kind: EventKind.USER_INPUT,
      session_id: 'sess-1',
      data: { content: 'hello' },
    });
  });

  it('wildcard listener receives all events', () => {
    const em = new EventEmitter('sess-1');
    const wildcard = vi.fn();
    em.on('*', wildcard);
    em.emit(EventKind.USER_INPUT);
    em.emit(EventKind.SESSION_END);
    expect(wildcard).toHaveBeenCalledTimes(2);
    expect(wildcard.mock.calls[0][0].kind).toBe(EventKind.USER_INPUT);
    expect(wildcard.mock.calls[1][0].kind).toBe(EventKind.SESSION_END);
  });

  it('multiple listeners for the same event', () => {
    const em = new EventEmitter('sess-1');
    const l1 = vi.fn();
    const l2 = vi.fn();
    em.on(EventKind.ERROR, l1);
    em.on(EventKind.ERROR, l2);
    em.emit(EventKind.ERROR, { error: 'boom' });
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it('listener removal via off()', () => {
    const em = new EventEmitter('sess-1');
    const listener = vi.fn();
    em.on(EventKind.WARNING, listener);
    em.emit(EventKind.WARNING);
    expect(listener).toHaveBeenCalledTimes(1);
    em.off(EventKind.WARNING, listener);
    em.emit(EventKind.WARNING);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('on() returns unsubscribe function', () => {
    const em = new EventEmitter('sess-1');
    const listener = vi.fn();
    const unsub = em.on(EventKind.LLM_CALL_START, listener);
    em.emit(EventKind.LLM_CALL_START);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    em.emit(EventKind.LLM_CALL_START);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('wildcard removal via off("*")', () => {
    const em = new EventEmitter('sess-1');
    const wildcard = vi.fn();
    em.on('*', wildcard);
    em.emit(EventKind.USER_INPUT);
    expect(wildcard).toHaveBeenCalledTimes(1);
    em.off('*', wildcard);
    em.emit(EventKind.USER_INPUT);
    expect(wildcard).toHaveBeenCalledTimes(1);
  });

  it('removeAllListeners clears everything', () => {
    const em = new EventEmitter('sess-1');
    const l1 = vi.fn();
    const l2 = vi.fn();
    em.on(EventKind.ERROR, l1);
    em.on('*', l2);
    em.removeAllListeners();
    em.emit(EventKind.ERROR);
    expect(l1).not.toHaveBeenCalled();
    expect(l2).not.toHaveBeenCalled();
  });

  it('listener not called for other event kinds', () => {
    const em = new EventEmitter('sess-1');
    const listener = vi.fn();
    em.on(EventKind.USER_INPUT, listener);
    em.emit(EventKind.ERROR);
    expect(listener).not.toHaveBeenCalled();
  });

  it('emit returns the SessionEvent object', () => {
    const em = new EventEmitter('sess-1');
    const event = em.emit(EventKind.USER_INPUT, { content: 'test' });
    expect(event).toMatchObject({
      kind: EventKind.USER_INPUT,
      session_id: 'sess-1',
      data: { content: 'test' },
    });
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  describe('buffering', () => {
    it('buffered events are not delivered until flush', () => {
      const em = new EventEmitter('sess-1');
      const listener = vi.fn();
      em.on(EventKind.USER_INPUT, listener);
      em.startBuffering();
      em.emit(EventKind.USER_INPUT);
      expect(listener).not.toHaveBeenCalled();
      em.flush();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('flush delivers events in order', () => {
      const em = new EventEmitter('sess-1');
      const events: string[] = [];
      em.on('*', (e) => events.push(e.kind));
      em.startBuffering();
      em.emit(EventKind.LLM_CALL_START);
      em.emit(EventKind.LLM_CALL_END);
      em.emit(EventKind.TURN_COMPLETE);
      em.flush();
      expect(events).toEqual([
        EventKind.LLM_CALL_START,
        EventKind.LLM_CALL_END,
        EventKind.TURN_COMPLETE,
      ]);
    });
  });

  describe('asyncIterator', () => {
    it('yields events as they arrive', async () => {
      const em = new EventEmitter('sess-1');
      const iter = em.asyncIterator();

      em.emit(EventKind.USER_INPUT, { content: 'a' });
      em.emit(EventKind.LLM_CALL_START, { model: 'x' });

      const r1 = await iter.next();
      expect(r1.done).toBe(false);
      expect(r1.value.kind).toBe(EventKind.USER_INPUT);

      const r2 = await iter.next();
      expect(r2.done).toBe(false);
      expect(r2.value.kind).toBe(EventKind.LLM_CALL_START);

      // Clean up
      await iter.return!();
    });

    it('completes on SESSION_END', async () => {
      const em = new EventEmitter('sess-1');
      const iter = em.asyncIterator();

      em.emit(EventKind.USER_INPUT);
      em.emit(EventKind.SESSION_END);

      const r1 = await iter.next();
      expect(r1.done).toBe(false);
      expect(r1.value.kind).toBe(EventKind.USER_INPUT);

      // SESSION_END is delivered as a value, and then done
      const r2 = await iter.next();
      expect(r2.done).toBe(false);
      expect(r2.value.kind).toBe(EventKind.SESSION_END);

      const r3 = await iter.next();
      expect(r3.done).toBe(true);
    });

    it('filters by kind when kinds array provided', async () => {
      const em = new EventEmitter('sess-1');
      const iter = em.asyncIterator([EventKind.ERROR]);

      em.emit(EventKind.USER_INPUT);
      em.emit(EventKind.ERROR, { error: 'oops' });

      const r1 = await iter.next();
      expect(r1.done).toBe(false);
      expect(r1.value.kind).toBe(EventKind.ERROR);

      await iter.return!();
    });

    it('next() blocks until an event arrives', async () => {
      const em = new EventEmitter('sess-1');
      const iter = em.asyncIterator();

      let resolved = false;
      const promise = iter.next().then((r) => {
        resolved = true;
        return r;
      });

      // Should not be resolved yet
      await new Promise((r) => setTimeout(r, 10));
      expect(resolved).toBe(false);

      em.emit(EventKind.USER_INPUT);
      const result = await promise;
      expect(resolved).toBe(true);
      expect(result.value.kind).toBe(EventKind.USER_INPUT);

      await iter.return!();
    });

    it('return() completes the iterator', async () => {
      const em = new EventEmitter('sess-1');
      const iter = em.asyncIterator();

      const result = await iter.return!();
      expect(result.done).toBe(true);

      const next = await iter.next();
      expect(next.done).toBe(true);
    });
  });
});
