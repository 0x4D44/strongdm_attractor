/**
 * Tool output truncation.
 *
 * Two-pass pipeline:
 *  1. Character-based truncation (primary safeguard, always runs first)
 *  2. Line-based truncation (secondary readability pass)
 */

import type { SessionConfig } from './types.js';

// ---------------------------------------------------------------------------
// Default limits
// ---------------------------------------------------------------------------

/** Default character limits per tool */
export const DEFAULT_TOOL_CHAR_LIMITS: Record<string, number> = {
  read_file: 50_000,
  shell: 30_000,
  grep: 20_000,
  glob: 20_000,
  edit_file: 10_000,
  apply_patch: 10_000,
  write_file: 1_000,
  spawn_agent: 20_000,
  read_many_files: 50_000,
  list_dir: 20_000,
  web_search: 20_000,
  web_fetch: 50_000,
};

/** Default truncation modes per tool */
export const DEFAULT_TRUNCATION_MODES: Record<string, 'head_tail' | 'tail'> = {
  read_file: 'head_tail',
  shell: 'head_tail',
  grep: 'tail',
  glob: 'tail',
  edit_file: 'tail',
  apply_patch: 'tail',
  write_file: 'tail',
  spawn_agent: 'head_tail',
  read_many_files: 'head_tail',
  list_dir: 'tail',
  web_search: 'tail',
  web_fetch: 'head_tail',
};

/** Default line limits per tool (null = no line limit) */
export const DEFAULT_TOOL_LINE_LIMITS: Record<string, number | null> = {
  shell: 256,
  grep: 200,
  glob: 500,
  read_file: null,
  edit_file: null,
  apply_patch: null,
  write_file: null,
  spawn_agent: null,
  read_many_files: null,
  list_dir: 500,
  web_search: null,
  web_fetch: null,
};

/** Fallback character limit for unknown tools */
const DEFAULT_CHAR_LIMIT = 30_000;

// ---------------------------------------------------------------------------
// Character-based truncation
// ---------------------------------------------------------------------------

/**
 * Truncate output by character count.
 * Uses head/tail split or tail-only based on mode.
 */
export function truncateByChars(
  output: string,
  maxChars: number,
  mode: 'head_tail' | 'tail' = 'head_tail',
): string {
  if (output.length <= maxChars) {
    return output;
  }

  const removed = output.length - maxChars;

  if (mode === 'head_tail') {
    const half = Math.floor(maxChars / 2);
    const head = output.slice(0, half);
    const tail = output.slice(-half);
    return (
      head +
      `\n\n[WARNING: Tool output was truncated. ` +
      `${removed} characters were removed from the middle. ` +
      `The full output is available in the event stream. ` +
      `If you need to see specific parts, re-run the tool with more targeted parameters.]\n\n` +
      tail
    );
  }

  // tail mode
  const kept = output.slice(-maxChars);
  return (
    `[WARNING: Tool output was truncated. First ` +
    `${removed} characters were removed. ` +
    `The full output is available in the event stream.]\n\n` +
    kept
  );
}

// ---------------------------------------------------------------------------
// Line-based truncation
// ---------------------------------------------------------------------------

/**
 * Truncate output by line count using head/tail split.
 */
export function truncateByLines(output: string, maxLines: number): string {
  const lines = output.split('\n');
  if (lines.length <= maxLines) {
    return output;
  }

  const headCount = Math.floor(maxLines / 2);
  const tailCount = maxLines - headCount;
  const omitted = lines.length - headCount - tailCount;

  const head = lines.slice(0, headCount).join('\n');
  const tail = lines.slice(-tailCount).join('\n');

  return head + `\n[... ${omitted} lines omitted ...]\n` + tail;
}

// ---------------------------------------------------------------------------
// Combined truncation pipeline
// ---------------------------------------------------------------------------

/**
 * Full truncation pipeline: char-based first, then line-based.
 * This is the function called by the agentic loop.
 */
export function truncateToolOutput(
  output: string,
  toolName: string,
  config: SessionConfig,
): string {
  // Step 1: Character-based truncation (always first)
  const maxChars =
    config.tool_output_limits.get(toolName) ??
    DEFAULT_TOOL_CHAR_LIMITS[toolName] ??
    DEFAULT_CHAR_LIMIT;
  const mode = DEFAULT_TRUNCATION_MODES[toolName] ?? 'head_tail';
  let result = truncateByChars(output, maxChars, mode);

  // Step 2: Line-based truncation (secondary)
  const maxLines =
    config.tool_line_limits.get(toolName) ??
    DEFAULT_TOOL_LINE_LIMITS[toolName] ??
    null;
  if (maxLines !== null) {
    result = truncateByLines(result, maxLines);
  }

  return result;
}
