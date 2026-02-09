import { describe, it, expect } from 'vitest';
import {
  truncateByChars,
  truncateByLines,
  truncateToolOutput,
  DEFAULT_TOOL_CHAR_LIMITS,
  DEFAULT_TOOL_LINE_LIMITS,
} from './truncation.js';
import type { SessionConfig } from './types.js';

function makeConfig(overrides?: {
  charLimits?: Record<string, number>;
  lineLimits?: Record<string, number>;
}): SessionConfig {
  return {
    max_turns: 0,
    max_tool_rounds_per_input: 200,
    default_command_timeout_ms: 10_000,
    max_command_timeout_ms: 600_000,
    reasoning_effort: null,
    tool_output_limits: new Map(
      Object.entries(overrides?.charLimits ?? {}),
    ),
    tool_line_limits: new Map(
      Object.entries(overrides?.lineLimits ?? {}),
    ),
    enable_loop_detection: true,
    loop_detection_window: 10,
    max_subagent_depth: 1,
    user_instructions: null,
  };
}

describe('truncateByChars', () => {
  it('output under limit passes through unchanged', () => {
    const input = 'short string';
    expect(truncateByChars(input, 100)).toBe(input);
  });

  it('output exactly at limit passes through', () => {
    const input = 'x'.repeat(100);
    expect(truncateByChars(input, 100)).toBe(input);
  });

  it('head_tail mode: keeps beginning and end, removes middle', () => {
    const input = 'A'.repeat(50) + 'B'.repeat(50) + 'C'.repeat(50);
    const result = truncateByChars(input, 80, 'head_tail');

    // Should have head (40 chars) + marker + tail (40 chars)
    expect(result.startsWith('A'.repeat(40))).toBe(true);
    expect(result.endsWith('C'.repeat(40))).toBe(true);
    expect(result).toContain('[WARNING: Tool output was truncated.');
    expect(result).toContain('70 characters were removed from the middle');
  });

  it('tail mode: keeps the end, removes beginning', () => {
    const input = 'A'.repeat(50) + 'B'.repeat(50);
    const result = truncateByChars(input, 60, 'tail');

    expect(result).toContain('[WARNING: Tool output was truncated. First');
    expect(result).toContain('40 characters were removed');
    expect(result.endsWith('B'.repeat(50))).toBe(true);
  });

  it('empty string passes through', () => {
    expect(truncateByChars('', 100)).toBe('');
  });

  it('truncation marker is present in truncated output', () => {
    const input = 'x'.repeat(200);
    const result = truncateByChars(input, 100);
    expect(result).toContain('WARNING');
    expect(result).toContain('truncated');
  });
});

describe('truncateByLines', () => {
  it('output under limit passes through', () => {
    const input = 'line1\nline2\nline3';
    expect(truncateByLines(input, 10)).toBe(input);
  });

  it('excess lines are removed from the middle', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const input = lines.join('\n');
    const result = truncateByLines(input, 6);

    // head: 3 lines, tail: 3 lines
    expect(result).toContain('line1');
    expect(result).toContain('line3');
    expect(result).toContain('line18');
    expect(result).toContain('line20');
    expect(result).toContain('[... 14 lines omitted ...]');
  });

  it('exactly at limit passes through', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line${i}`);
    const input = lines.join('\n');
    expect(truncateByLines(input, 5)).toBe(input);
  });

  it('single line passes through', () => {
    const input = 'just one line';
    expect(truncateByLines(input, 1)).toBe(input);
  });
});

describe('truncateToolOutput (combined pipeline)', () => {
  it('character truncation runs first, then line truncation', () => {
    // Create a string that will be char-truncated then line-truncated
    const longLines = Array.from({ length: 300 }, (_, i) =>
      `line${i}: ${'x'.repeat(200)}`,
    ).join('\n');

    const config = makeConfig({
      charLimits: { shell: 5000 },
      lineLimits: { shell: 10 },
    });
    const result = truncateToolOutput(longLines, 'shell', config);

    // Should be char-truncated first, then line-truncated
    expect(result.length).toBeLessThan(longLines.length);
    // Line truncation adds its own marker
    expect(
      result.includes('[...') || result.includes('[WARNING'),
    ).toBe(true);
  });

  it('per-tool limits: read_file=50k default', () => {
    expect(DEFAULT_TOOL_CHAR_LIMITS['read_file']).toBe(50_000);
  });

  it('per-tool limits: shell=30k default', () => {
    expect(DEFAULT_TOOL_CHAR_LIMITS['shell']).toBe(30_000);
  });

  it('per-tool limits: grep=20k default', () => {
    expect(DEFAULT_TOOL_CHAR_LIMITS['grep']).toBe(20_000);
  });

  it('per-tool line limits: shell=256 default', () => {
    expect(DEFAULT_TOOL_LINE_LIMITS['shell']).toBe(256);
  });

  it('unknown tool uses default 30k char limit', () => {
    const config = makeConfig();
    const input = 'x'.repeat(40_000);
    const result = truncateToolOutput(input, 'unknown_tool', config);
    expect(result).toContain('WARNING');
    // 30k default applies
    expect(result.length).toBeLessThan(40_000);
  });

  it('config overrides take precedence', () => {
    const config = makeConfig({ charLimits: { read_file: 100 } });
    const input = 'x'.repeat(200);
    const result = truncateToolOutput(input, 'read_file', config);
    expect(result).toContain('WARNING');
  });

  it('no line truncation when tool has null line limit', () => {
    const config = makeConfig();
    // read_file has null line limit by default
    const lines = Array.from({ length: 1000 }, (_, i) => `L${i}`).join('\n');
    // Keep it under char limit
    const result = truncateToolOutput(lines, 'read_file', config);
    // No line omission marker since read_file has no line limit
    expect(result).not.toContain('[...');
  });
});
