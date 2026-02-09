import { describe, it, expect } from 'vitest';
import { parseDuration } from './utils.js';

describe('parseDuration', () => {
  it('parses milliseconds', () => {
    expect(parseDuration('250ms')).toBe(250);
  });

  it('parses seconds', () => {
    expect(parseDuration('45s')).toBe(45_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('15m')).toBe(15 * 60 * 1000);
  });

  it('parses hours', () => {
    expect(parseDuration('2h')).toBe(2 * 60 * 60 * 1000);
  });

  it('parses days', () => {
    expect(parseDuration('1d')).toBe(24 * 60 * 60 * 1000);
  });

  it('parses plain number as milliseconds', () => {
    expect(parseDuration('500')).toBe(500);
  });

  it('returns 0 for invalid duration string', () => {
    expect(parseDuration('garbage')).toBe(0);
  });

  it('handles negative values', () => {
    expect(parseDuration('-5s')).toBe(-5000);
  });

  it('handles zero', () => {
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration('0ms')).toBe(0);
    expect(parseDuration('0')).toBe(0);
  });

  it('parses large values', () => {
    expect(parseDuration('900s')).toBe(900_000);
    expect(parseDuration('1000ms')).toBe(1000);
  });
});
