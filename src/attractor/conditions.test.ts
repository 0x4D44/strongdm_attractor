import { describe, it, expect } from 'vitest';
import { evaluateCondition, resolveKey } from './conditions.js';
import { StageStatus, makeOutcome } from './types.js';
import { Context } from './engine/context.js';

function makeContext(values: Record<string, unknown> = {}): Context {
  const ctx = new Context();
  for (const [k, v] of Object.entries(values)) {
    ctx.set(k, v);
  }
  return ctx;
}

function makeOutcomeWith(status: StageStatus, preferred_label = ''): ReturnType<typeof makeOutcome> {
  return makeOutcome({ status, preferred_label });
}

describe('evaluateCondition', () => {
  it('= equals operator matches', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(evaluateCondition('outcome=success', outcome, ctx)).toBe(true);
  });

  it('= equals operator does not match', () => {
    const outcome = makeOutcomeWith(StageStatus.FAIL);
    const ctx = makeContext();
    expect(evaluateCondition('outcome=success', outcome, ctx)).toBe(false);
  });

  it('!= not-equals operator matches', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(evaluateCondition('outcome!=fail', outcome, ctx)).toBe(true);
  });

  it('!= not-equals operator does not match', () => {
    const outcome = makeOutcomeWith(StageStatus.FAIL);
    const ctx = makeContext();
    expect(evaluateCondition('outcome!=fail', outcome, ctx)).toBe(false);
  });

  it('&& conjunction: both clauses must match', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ x: '1' });
    expect(evaluateCondition('outcome=success && context.x=1', outcome, ctx)).toBe(true);
  });

  it('&& conjunction: fails when one clause does not match', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ x: '2' });
    expect(evaluateCondition('outcome=success && context.x=1', outcome, ctx)).toBe(false);
  });

  it('empty condition evaluates to true (unconditional edge)', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(evaluateCondition('', outcome, ctx)).toBe(true);
    expect(evaluateCondition('  ', outcome, ctx)).toBe(true);
  });

  it('whitespace handling in conditions', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(evaluateCondition('  outcome = success  ', outcome, ctx)).toBe(true);
  });

  it('missing context key = empty string', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(evaluateCondition('context.missing=', outcome, ctx)).toBe(true);
  });
});

describe('resolveKey', () => {
  it('outcome variable resolves to outcome status', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(resolveKey('outcome', outcome, ctx)).toBe('success');
  });

  it('preferred_label variable resolves correctly', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS, 'next step');
    const ctx = makeContext();
    expect(resolveKey('preferred_label', outcome, ctx)).toBe('next step');
  });

  it('context.* variables resolve to context values', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ foo: 'bar' });
    expect(resolveKey('context.foo', outcome, ctx)).toBe('bar');
  });

  it('missing context key returns empty string', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(resolveKey('context.nonexistent', outcome, ctx)).toBe('');
  });

  it('unqualified keys resolve via direct context lookup', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ mykey: 'myval' });
    expect(resolveKey('mykey', outcome, ctx)).toBe('myval');
  });

  it('missing unqualified key returns empty string', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(resolveKey('nokey', outcome, ctx)).toBe('');
  });

  it('preferred_label returns empty string when absent', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(resolveKey('preferred_label', outcome, ctx)).toBe('');
  });

  it('context.* tries full key first, then short key', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    // Context has both "context.x" and "x" keys
    const ctx = makeContext({ 'context.x': 'full', x: 'short' });
    expect(resolveKey('context.x', outcome, ctx)).toBe('full');
  });

  it('context.* falls back to short key if full key not found', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ x: 'short' });
    expect(resolveKey('context.x', outcome, ctx)).toBe('short');
  });

  it('context.* distinguishes from non-context keys', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ myvar: 'val' });
    // "context." prefix should not match "myvar"
    expect(resolveKey('context.myvar', outcome, ctx)).toBe('val');
    expect(resolveKey('myvar', outcome, ctx)).toBe('val');
    // But "context.other" should return '' when "other" is missing
    expect(resolveKey('context.other', outcome, ctx)).toBe('');
  });

  it('handles null context values (returns empty string)', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ nullval: null });
    expect(resolveKey('nullval', outcome, ctx)).toBe('');
  });

  it('trims whitespace from key', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ key: 'val' });
    expect(resolveKey('  key  ', outcome, ctx)).toBe('val');
  });
});

describe('evaluateCondition - bare key truthiness', () => {
  it('bare key with truthy value returns true', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ flag: 'yes' });
    expect(evaluateCondition('flag', outcome, ctx)).toBe(true);
  });

  it('bare key with empty string returns false', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ flag: '' });
    expect(evaluateCondition('flag', outcome, ctx)).toBe(false);
  });

  it('bare key with "0" returns false', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ flag: '0' });
    expect(evaluateCondition('flag', outcome, ctx)).toBe(false);
  });

  it('bare key with "false" returns false', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ flag: 'false' });
    expect(evaluateCondition('flag', outcome, ctx)).toBe(false);
  });

  it('bare key with "1" returns true', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ flag: '1' });
    expect(evaluateCondition('flag', outcome, ctx)).toBe(true);
  });

  it('bare key with "true" returns true', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext({ flag: 'true' });
    expect(evaluateCondition('flag', outcome, ctx)).toBe(true);
  });

  it('missing bare key returns false', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(evaluateCondition('missing', outcome, ctx)).toBe(false);
  });
});

describe('evaluateCondition - quoted values (unquote)', () => {
  it('matches quoted string values', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(evaluateCondition('outcome="success"', outcome, ctx)).toBe(true);
    expect(evaluateCondition('outcome="fail"', outcome, ctx)).toBe(false);
  });

  it('not-equals with quoted values', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(evaluateCondition('outcome!="fail"', outcome, ctx)).toBe(true);
    expect(evaluateCondition('outcome!="success"', outcome, ctx)).toBe(false);
  });

  it('unquote only strips matching double quotes', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    // No quotes - value used as-is
    expect(evaluateCondition('outcome=success', outcome, ctx)).toBe(true);
  });
});

describe('evaluateCondition - empty clause handling', () => {
  it('empty clause in conjunction is treated as true', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    // Trailing && creates an empty clause
    expect(evaluateCondition('outcome=success && ', outcome, ctx)).toBe(true);
  });

  it('handles whitespace-only condition', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(evaluateCondition('   ', outcome, ctx)).toBe(true);
  });

  it('handles null-ish condition', () => {
    const outcome = makeOutcomeWith(StageStatus.SUCCESS);
    const ctx = makeContext();
    expect(evaluateCondition('', outcome, ctx)).toBe(true);
  });
});
