/**
 * Property-based / fuzz tests for the condition evaluator.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluateCondition, resolveKey } from '../attractor/conditions.js';
import { StageStatus } from '../attractor/types.js';
import type { Outcome, PipelineContext } from '../attractor/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutcome(overrides: Partial<Outcome> = {}): Outcome {
  return {
    status: StageStatus.SUCCESS,
    preferred_label: '',
    suggested_next_ids: [],
    context_updates: {},
    notes: '',
    failure_reason: '',
    ...overrides,
  };
}

function makeContext(data: Record<string, unknown> = {}): PipelineContext {
  const store = new Map<string, unknown>(Object.entries(data));
  return {
    set(key: string, value: unknown) { store.set(key, value); },
    get(key: string, defaultValue?: unknown) { return store.get(key) ?? defaultValue; },
    getString(key: string, defaultValue = '') { return String(store.get(key) ?? defaultValue); },
    appendLog() {},
    snapshot() { return Object.fromEntries(store); },
    clone() { return makeContext(Object.fromEntries(store)); },
    applyUpdates(updates: Record<string, unknown>) {
      for (const [k, v] of Object.entries(updates)) store.set(k, v);
    },
    getLogs() { return []; },
  };
}

// ---------------------------------------------------------------------------
// Arbitrary generators
// ---------------------------------------------------------------------------

const arbKey = fc.oneof(
  fc.constantFrom('outcome', 'preferred_label'),
  fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz._'.split('')), { minLength: 1, maxLength: 20 })
    .map(arr => arr.join('')),
);

const arbValue = fc.oneof(
  fc.constantFrom('success', 'fail', 'retry', 'partial_success', 'skipped'),
  fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 0, maxLength: 15 })
    .map(arr => arr.join('')),
);

const arbOperator = fc.constantFrom('=', '!=');

/** A well-formed clause: key op value */
const arbClause = fc.tuple(arbKey, arbOperator, arbValue).map(
  ([key, op, val]) => `${key}${op}${val}`,
);

/** A well-formed condition expression with 1-3 clauses joined by &&. */
const arbCondition = fc.array(arbClause, { minLength: 1, maxLength: 3 }).map(
  clauses => clauses.join(' && '),
);

const arbStatus = fc.constantFrom(
  StageStatus.SUCCESS,
  StageStatus.PARTIAL_SUCCESS,
  StageStatus.RETRY,
  StageStatus.FAIL,
  StageStatus.SKIPPED,
);

const arbOutcome = fc.tuple(
  arbStatus,
  fc.string({ minLength: 0, maxLength: 20 }),
).map(([status, label]) => makeOutcome({ status, preferred_label: label }));

const arbContextData = fc.dictionary(
  fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz.'.split('')), { minLength: 1, maxLength: 15 })
    .map(arr => arr.join('')),
  fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean()),
  { minKeys: 0, maxKeys: 5 },
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Condition evaluator fuzz tests', () => {
  it('never crashes on arbitrary string input', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        arbOutcome,
        arbContextData,
        (condition, outcome, data) => {
          const ctx = makeContext(data);
          const result = evaluateCondition(condition, outcome, ctx);
          expect(typeof result).toBe('boolean');
        },
      ),
      { numRuns: 500 },
    );
  });

  it('well-formed conditions always return boolean', () => {
    fc.assert(
      fc.property(
        arbCondition,
        arbOutcome,
        arbContextData,
        (condition, outcome, data) => {
          const ctx = makeContext(data);
          const result = evaluateCondition(condition, outcome, ctx);
          expect(typeof result).toBe('boolean');
        },
      ),
      { numRuns: 500 },
    );
  });

  it('empty/whitespace condition always returns true', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', '\t', '\n', ''), { minLength: 0, maxLength: 20 })
          .map(arr => arr.join('')),
        arbOutcome,
        arbContextData,
        (condition, outcome, data) => {
          const ctx = makeContext(data);
          expect(evaluateCondition(condition, outcome, ctx)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('outcome=success matches when status is success', () => {
    fc.assert(
      fc.property(arbContextData, (data) => {
        const outcome = makeOutcome({ status: StageStatus.SUCCESS });
        const ctx = makeContext(data);
        expect(evaluateCondition('outcome=success', outcome, ctx)).toBe(true);
        expect(evaluateCondition('outcome!=success', outcome, ctx)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('outcome equality is reflexive for any status', () => {
    fc.assert(
      fc.property(arbStatus, arbContextData, (status, data) => {
        const outcome = makeOutcome({ status });
        const ctx = makeContext(data);
        expect(evaluateCondition(`outcome=${status}`, outcome, ctx)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('!= is the negation of =', () => {
    fc.assert(
      fc.property(arbKey, arbValue, arbOutcome, arbContextData, (key, val, outcome, data) => {
        const ctx1 = makeContext(data);
        const ctx2 = makeContext(data);
        const eq = evaluateCondition(`${key}=${val}`, outcome, ctx1);
        const neq = evaluateCondition(`${key}!=${val}`, outcome, ctx2);
        expect(eq).not.toBe(neq);
      }),
      { numRuns: 300 },
    );
  });

  it('conjunction (&&) is at most as true as any individual clause', () => {
    fc.assert(
      fc.property(
        fc.array(arbClause, { minLength: 2, maxLength: 4 }),
        arbOutcome,
        arbContextData,
        (clauses, outcome, data) => {
          const ctx = makeContext(data);
          const combined = evaluateCondition(clauses.join(' && '), outcome, ctx);
          if (combined) {
            for (const clause of clauses) {
              const individual = evaluateCondition(clause, outcome, makeContext(data));
              expect(individual).toBe(true);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('resolveKey never crashes on arbitrary keys', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100 }),
        arbOutcome,
        arbContextData,
        (key, outcome, data) => {
          const ctx = makeContext(data);
          const result = resolveKey(key, outcome, ctx);
          expect(typeof result).toBe('string');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('resolveKey("outcome") returns the outcome status', () => {
    fc.assert(
      fc.property(arbOutcome, (outcome) => {
        const ctx = makeContext();
        expect(resolveKey('outcome', outcome, ctx)).toBe(outcome.status);
      }),
      { numRuns: 100 },
    );
  });

  it('context.key resolves from context', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...'abcdefghij'.split('')), { minLength: 1, maxLength: 8 })
          .map(arr => arr.join('')),
        fc.string({ minLength: 1, maxLength: 20 }),
        arbOutcome,
        (key, value, outcome) => {
          const ctx = makeContext({ [key]: value });
          const result = resolveKey(`context.${key}`, outcome, ctx);
          expect(result).toBe(value);
        },
      ),
      { numRuns: 200 },
    );
  });
});
