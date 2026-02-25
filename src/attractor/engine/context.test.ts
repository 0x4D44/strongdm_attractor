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

  it('nested key with null intermediate returns default', () => {
    const ctx = new Context();
    ctx.set('obj', { nested: null });
    expect(ctx.get('obj.nested.deep', 'fallback')).toBe('fallback');
  });

  it('nested key with non-object intermediate returns default', () => {
    const ctx = new Context();
    ctx.set('obj', { nested: 42 });
    expect(ctx.get('obj.nested.deep', 'fallback')).toBe('fallback');
  });

  it('nested key with undefined intermediate returns default', () => {
    const ctx = new Context();
    ctx.set('obj', { nested: undefined });
    expect(ctx.get('obj.nested.deep', 'fallback')).toBe('fallback');
  });

  it('getString returns default for null value', () => {
    const ctx = new Context();
    ctx.set('key', null);
    expect(ctx.getString('key', 'default')).toBe('default');
  });

  it('deep nested key with multiple levels', () => {
    const ctx = new Context();
    ctx.set('a', { b: { c: { d: 'found' } } });
    expect(ctx.get('a.b.c.d')).toBe('found');
  });

  it('prefix matching: dot-separated flat key takes precedence', () => {
    const ctx = new Context();
    ctx.set('a.b', 'flat_value');
    ctx.set('a', { b: 'nested_value' });
    // 'a.b' as a flat key should be found first
    expect(ctx.get('a.b')).toBe('flat_value');
  });

  it('nested key from object-valued prefix', () => {
    const ctx = new Context();
    ctx.set('config', { database: { host: 'localhost', port: 5432 } });
    expect(ctx.get('config.database.host')).toBe('localhost');
    expect(ctx.get('config.database.port')).toBe(5432);
  });

  it('returns defaultValue for nested key when prefix exists but path fails', () => {
    const ctx = new Context();
    ctx.set('obj', { a: 'value' });
    expect(ctx.get('obj.b.c', 'missing')).toBe('missing');
  });

  it('progressive prefix matching finds longer prefix over shorter', () => {
    // Set 'a' as an object but also set 'a.b' directly as a map entry
    // The progressive matcher should find the 'a.b' prefix when looking for 'a.b.c'
    const ctx = new Context();
    ctx.set('a', { b: 'wrong' }); // this is the short prefix
    ctx.set('a.b', { c: 'right' }); // this is the longer prefix
    expect(ctx.get('a.b.c')).toBe('right');
  });

  it('nested key resolution where entire key is a prefix match at full length', () => {
    // This tests the path where i === parts.length in the progressive prefix matching
    // 'a.b.c' as a flat key should be found when 'a.b' is also set
    const ctx = new Context();
    ctx.set('a.b', { c: 'nested_value' });
    expect(ctx.get('a.b.c')).toBe('nested_value');
  });

  it('nested key with string intermediate returns default', () => {
    const ctx = new Context();
    ctx.set('obj', { nested: 'a string' });
    expect(ctx.get('obj.nested.deep', 'nope')).toBe('nope');
  });

  it('nested key where prefix found at i !== parts.length descends into object (line 31)', () => {
    // Tests the branch at line 31: i !== parts.length
    // Set 'a' as an object with nested 'b.c' — force prefix match at i=1, then descend
    const ctx = new Context();
    ctx.set('a', { b: { c: 1 } });
    expect(ctx.get('a.b.c')).toBe(1);
  });

  it('nested key where prefix match at exact length returns directly (line 31 true branch)', () => {
    // Tests the branch at line 31: i === parts.length
    // This is a flat dotted key that matches the full path
    const ctx = new Context();
    ctx.set('x.y', 'flat_val');
    expect(ctx.get('x.y')).toBe('flat_val');
  });
});
