/**
 * Pipeline execution context: thread-safe key-value store shared across nodes.
 * Supports nested keys via dot notation and context cloning for parallel branches.
 */

import type { PipelineContext } from '../types.js';

export class Context implements PipelineContext {
  private values: Map<string, unknown> = new Map();
  private logs: string[] = [];

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  get(key: string, defaultValue?: unknown): unknown {
    // Direct lookup
    if (this.values.has(key)) {
      return this.values.get(key);
    }

    // Try nested key resolution: if key is "a.b.c", check if "a" is an object
    const parts = key.split('.');
    if (parts.length > 1) {
      let current: unknown = undefined;

      // Try progressive prefix matching
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('.');
        if (this.values.has(prefix)) {
          if (i === parts.length) {
            return this.values.get(prefix);
          }
          // Found a prefix, try to descend into the value
          current = this.values.get(prefix);
          const remaining = parts.slice(i);
          for (const part of remaining) {
            if (current !== null && current !== undefined && typeof current === 'object') {
              current = (current as Record<string, unknown>)[part];
            } else {
              current = undefined;
              break;
            }
          }
          if (current !== undefined) return current;
        }
      }
    }

    return defaultValue;
  }

  getString(key: string, defaultValue: string = ''): string {
    const value = this.get(key);
    if (value === undefined || value === null) return defaultValue;
    return String(value);
  }

  appendLog(entry: string): void {
    this.logs.push(entry);
  }

  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.values) {
      result[key] = value;
    }
    return result;
  }

  clone(): PipelineContext {
    const cloned = new Context();
    for (const [key, value] of this.values) {
      cloned.values.set(key, structuredClone(value));
    }
    cloned.logs = [...this.logs];
    return cloned;
  }

  applyUpdates(updates: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(updates)) {
      this.values.set(key, value);
    }
  }

  getLogs(): string[] {
    return [...this.logs];
  }
}
