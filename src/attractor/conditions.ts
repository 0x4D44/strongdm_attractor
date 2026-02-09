/**
 * Condition expression language for edge routing.
 * Grammar: ConditionExpr ::= Clause ( '&&' Clause )*
 *          Clause ::= Key Operator Literal
 *          Operator ::= '=' | '!='
 *          Key ::= 'outcome' | 'preferred_label' | 'context.' Path | bare_key
 */

import type { Outcome, PipelineContext } from './types.js';

// ---------------------------------------------------------------------------
// Variable Resolution
// ---------------------------------------------------------------------------

export function resolveKey(
  key: string,
  outcome: Outcome,
  context: PipelineContext,
): string {
  const trimmedKey = key.trim();

  if (trimmedKey === 'outcome') {
    return outcome.status;
  }

  if (trimmedKey === 'preferred_label') {
    return outcome.preferred_label || '';
  }

  if (trimmedKey.startsWith('context.')) {
    // Try full key first (context.foo.bar)
    const fullValue = context.get(trimmedKey);
    if (fullValue !== undefined && fullValue !== null) {
      return String(fullValue);
    }

    // Try without context. prefix (foo.bar)
    const shortKey = trimmedKey.substring('context.'.length);
    const shortValue = context.get(shortKey);
    if (shortValue !== undefined && shortValue !== null) {
      return String(shortValue);
    }

    return '';
  }

  // Direct context lookup for unqualified keys
  const value = context.get(trimmedKey);
  if (value !== undefined && value !== null) {
    return String(value);
  }

  return '';
}

// ---------------------------------------------------------------------------
// Clause Evaluation
// ---------------------------------------------------------------------------

function evaluateClause(
  clause: string,
  outcome: Outcome,
  context: PipelineContext,
): boolean {
  const trimmed = clause.trim();
  if (!trimmed) return true;

  // Check for != operator (before = to avoid ambiguity)
  const neqIndex = trimmed.indexOf('!=');
  if (neqIndex !== -1) {
    const key = trimmed.substring(0, neqIndex).trim();
    const value = trimmed.substring(neqIndex + 2).trim();
    const resolved = resolveKey(key, outcome, context);
    return resolved !== unquote(value);
  }

  // Check for = operator
  const eqIndex = trimmed.indexOf('=');
  if (eqIndex !== -1) {
    const key = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();
    const resolved = resolveKey(key, outcome, context);
    return resolved === unquote(value);
  }

  // Bare key: truthy check
  const resolved = resolveKey(trimmed, outcome, context);
  return Boolean(resolved) && resolved !== '0' && resolved !== 'false';
}

// ---------------------------------------------------------------------------
// Condition Evaluation
// ---------------------------------------------------------------------------

export function evaluateCondition(
  condition: string,
  outcome: Outcome,
  context: PipelineContext,
): boolean {
  if (!condition || !condition.trim()) {
    return true; // Empty condition = always eligible
  }

  const clauses = condition.split('&&');
  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    if (!evaluateClause(trimmed, outcome, context)) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.substring(1, value.length - 1);
  }
  return value;
}
