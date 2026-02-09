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
});
