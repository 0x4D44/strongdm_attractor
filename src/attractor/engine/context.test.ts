import { describe, it, expect } from 'vitest';
import { Context } from './context.js';

describe('Context', () => {
  it('set/get basic values', () => {
    const ctx = new Context();
    ctx.set('key', 'value');
    expect(ctx.get('key')).toBe('value');
  });

  it('get with default value', () => {
    const ctx = new Context();
    expect(ctx.get('missing', 'default')).toBe('default');
  });

  it('getString helper', () => {
    const ctx = new Context();
    ctx.set('num', 42);
    expect(ctx.getString('num')).toBe('42');
    expect(ctx.getString('missing', 'fallback')).toBe('fallback');
  });

  it('nested key access with dot notation', () => {
    const ctx = new Context();
    ctx.set('user', { name: 'Alice', address: { city: 'NYC' } });
    expect(ctx.get('user.name')).toBe('Alice');
    expect(ctx.get('user.address.city')).toBe('NYC');
  });

  it('applyUpdates merges key-value pairs', () => {
    const ctx = new Context();
    ctx.set('existing', 'keep');
    ctx.applyUpdates({ new_key: 'new_val', another: 123 });
    expect(ctx.get('existing')).toBe('keep');
    expect(ctx.get('new_key')).toBe('new_val');
    expect(ctx.get('another')).toBe(123);
  });

  it('snapshot returns plain object', () => {
    const ctx = new Context();
    ctx.set('a', 1);
    ctx.set('b', 'hello');
    const snap = ctx.snapshot();
    expect(snap).toEqual({ a: 1, b: 'hello' });
    expect(typeof snap).toBe('object');
    expect(snap).not.toBeInstanceOf(Map);
  });

  it('clone() creates independent deep copy', () => {
    const ctx = new Context();
    ctx.set('key', 'value');
    ctx.appendLog('log entry');

    const cloned = ctx.clone();
    expect(cloned.get('key')).toBe('value');
    expect(cloned.getLogs()).toEqual(['log entry']);
  });

  it('mutations to cloned context don\'t affect original', () => {
    const ctx = new Context();
    ctx.set('key', 'original');

    const cloned = ctx.clone();
    cloned.set('key', 'modified');

    expect(ctx.get('key')).toBe('original');
    expect(cloned.get('key')).toBe('modified');
  });

  it('mutations to objects inside cloned context don\'t leak back', () => {
    const ctx = new Context();
    ctx.set('obj', { nested: { value: 'original' } });

    const cloned = ctx.clone();
    const obj = cloned.get('obj') as { nested: { value: string } };
    obj.nested.value = 'modified';

    const origObj = ctx.get('obj') as { nested: { value: string } };
    expect(origObj.nested.value).toBe('original');
  });

  it('appendLog and getLogs', () => {
    const ctx = new Context();
    ctx.appendLog('entry 1');
    ctx.appendLog('entry 2');
    expect(ctx.getLogs()).toEqual(['entry 1', 'entry 2']);
  });

  it('getLogs returns a copy', () => {
    const ctx = new Context();
    ctx.appendLog('entry');
    const logs = ctx.getLogs();
    logs.push('extra');
    expect(ctx.getLogs()).toEqual(['entry']);
  });

  it('get returns undefined for missing key with no default', () => {
    const ctx = new Context();
    expect(ctx.get('nonexistent')).toBeUndefined();
  });
});
