/**
 * OpenAI Provider Profile — codex-rs aligned.
 *
 * Provides apply_patch (v4a format), read_file, write_file, shell, grep, glob.
 * System prompt mirrors codex-rs style.
 */

import { unlinkSync, renameSync } from 'node:fs';
import * as path from 'node:path';
import type {
  ProviderProfile,
  ToolDefinition,
  RegisteredTool,
  ExecutionEnvironment,
} from '../types.js';
import { ToolRegistry } from './registry.js';
import {
  readFileTool,
  writeFileTool,
  shellTool,
  grepTool,
  globTool,
} from './shared.js';
import { SUBAGENT_TOOL_DEFINITIONS } from '../subagent.js';

// ---------------------------------------------------------------------------
// apply_patch tool (v4a format) — OpenAI-specific
// ---------------------------------------------------------------------------

const applyPatchDefinition: ToolDefinition = {
  name: 'apply_patch',
  description:
    'Apply code changes using the v4a patch format. Supports creating, deleting, and modifying files in a single operation.',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'The patch content in v4a format.',
      },
    },
    required: ['patch'],
  },
};

interface Hunk {
  context_hint: string;
  lines: Array<{ op: ' ' | '+' | '-'; text: string }>;
}

interface PatchOp {
  kind: 'add' | 'delete' | 'update';
  path: string;
  move_to?: string;
  added_lines?: string[];
  hunks?: Hunk[];
}

function parsePatch(patch: string): PatchOp[] {
  const lines = patch.split('\n');
  const ops: PatchOp[] = [];
  let i = 0;

  // Skip to "*** Begin Patch"
  while (i < lines.length && !lines[i].startsWith('*** Begin Patch')) i++;
  i++; // skip the Begin line

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('*** End Patch')) break;

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const added: string[] = [];
      while (i < lines.length && lines[i].startsWith('+')) {
        added.push(lines[i].slice(1));
        i++;
      }
      ops.push({ kind: 'add', path, added_lines: added });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      ops.push({ kind: 'delete', path });
      i++;
    } else if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | undefined;
      if (i < lines.length && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      const hunks: Hunk[] = [];
      while (i < lines.length && lines[i].startsWith('@@ ')) {
        const contextHint = lines[i].slice(3).trim();
        i++;
        const hunkLines: Array<{ op: ' ' | '+' | '-'; text: string }> = [];
        while (
          i < lines.length &&
          !lines[i].startsWith('@@ ') &&
          !lines[i].startsWith('*** ')
        ) {
          const hl = lines[i];
          if (hl.startsWith(' ')) {
            hunkLines.push({ op: ' ', text: hl.slice(1) });
          } else if (hl.startsWith('+')) {
            hunkLines.push({ op: '+', text: hl.slice(1) });
          } else if (hl.startsWith('-')) {
            hunkLines.push({ op: '-', text: hl.slice(1) });
          }
          // ignore other lines
          i++;
        }
        hunks.push({ context_hint: contextHint, lines: hunkLines });
      }
      ops.push({ kind: 'update', path, move_to: moveTo, hunks });
    } else {
      i++;
    }
  }
  return ops;
}

function applyHunksToContent(content: string, hunks: Hunk[]): string {
  const fileLines = content.split('\n');

  // Process hunks from bottom to top to preserve line numbers
  for (let h = hunks.length - 1; h >= 0; h--) {
    const hunk = hunks[h];
    // Build the "old" lines from context and delete lines
    const oldLines = hunk.lines
      .filter((l) => l.op === ' ' || l.op === '-')
      .map((l) => l.text);
    const newLines = hunk.lines
      .filter((l) => l.op === ' ' || l.op === '+')
      .map((l) => l.text);

    // Find the old lines in the file
    let matchIdx = -1;

    // First try exact matching with context hint
    if (hunk.context_hint) {
      for (let i = 0; i < fileLines.length; i++) {
        if (fileLines[i].includes(hunk.context_hint)) {
          // Try to match old lines starting from around this position
          for (
            let start = Math.max(0, i - 3);
            start <= Math.min(fileLines.length - oldLines.length, i + 3);
            start++
          ) {
            if (linesMatch(fileLines, start, oldLines)) {
              matchIdx = start;
              break;
            }
          }
          if (matchIdx >= 0) break;
        }
      }
    }

    // Fall back to scanning the file
    if (matchIdx < 0) {
      for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
        if (linesMatch(fileLines, i, oldLines)) {
          matchIdx = i;
          break;
        }
      }
    }

    // Fuzzy match: normalize whitespace
    if (matchIdx < 0) {
      for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
        if (linesMatchFuzzy(fileLines, i, oldLines)) {
          matchIdx = i;
          break;
        }
      }
    }

    if (matchIdx < 0) {
      throw new Error(
        `Could not find matching context for hunk with hint: "${hunk.context_hint}"`,
      );
    }

    fileLines.splice(matchIdx, oldLines.length, ...newLines);
  }

  return fileLines.join('\n');
}

function linesMatch(
  fileLines: string[],
  start: number,
  pattern: string[],
): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (fileLines[start + i] !== pattern[i]) return false;
  }
  return true;
}

function linesMatchFuzzy(
  fileLines: string[],
  start: number,
  pattern: string[],
): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < pattern.length; i++) {
    if (normalize(fileLines[start + i]) !== normalize(pattern[i]))
      return false;
  }
  return true;
}

async function applyPatchExecutor(
  args: Record<string, unknown>,
  env: ExecutionEnvironment,
): Promise<string> {
  const patch = args.patch as string;
  const ops = parsePatch(patch);
  const results: string[] = [];

  for (const op of ops) {
    switch (op.kind) {
      case 'add': {
        const content = (op.added_lines ?? []).join('\n');
        await env.write_file(op.path, content);
        results.push(`Created ${op.path}`);
        break;
      }
      case 'delete': {
        const resolvedPath = path.resolve(env.working_directory(), op.path);
        try {
          unlinkSync(resolvedPath);
        } catch (e: unknown) {
          // Ignore ENOENT (file already gone), re-throw others
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        results.push(`Deleted ${op.path}`);
        break;
      }
      case 'update': {
        const existing = await env.read_file(op.path);
        const updated = applyHunksToContent(existing, op.hunks ?? []);

        const targetPath = op.move_to ?? op.path;
        await env.write_file(targetPath, updated);

        if (op.move_to && op.move_to !== op.path) {
          const oldResolved = path.resolve(env.working_directory(), op.path);
          try {
            unlinkSync(oldResolved);
          } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
          results.push(`Updated and moved ${op.path} -> ${op.move_to}`);
        } else {
          results.push(`Updated ${op.path}`);
        }
        break;
      }
    }
  }

  return results.join('\n') || 'No operations performed.';
}

export const applyPatchTool: RegisteredTool = {
  definition: applyPatchDefinition,
  executor: applyPatchExecutor,
};

// ---------------------------------------------------------------------------
// OpenAI System Prompt
// ---------------------------------------------------------------------------

function buildOpenAISystemPrompt(
  env: ExecutionEnvironment,
  projectDocs: string,
): string {
  const parts: string[] = [];

  // Base instructions (codex-rs style)
  parts.push(`You are a coding agent. You solve programming tasks by reading files, writing code, and executing commands.

## Guidelines
- Always read a file before editing it. Understand existing code before making changes.
- Use apply_patch for modifying existing files. Use write_file for creating new files.
- The apply_patch tool uses the v4a diff format with context lines for precise edits.
- Test your changes by running the appropriate build/test commands.
- Prefer minimal, focused changes. Don't rewrite entire files when a targeted edit suffices.
- If a command fails, read the error output carefully and fix the issue.
- When searching for code, use grep and glob to find relevant files before reading them.

## apply_patch format
Patches use the v4a format:
\`\`\`
*** Begin Patch
*** Update File: <path>
@@ <context hint>
 <context line>
-<line to remove>
+<line to add>
 <context line>
*** End Patch
\`\`\`

Space prefix = unchanged context line
Minus prefix = line to remove
Plus prefix = line to add`);

  // Environment context
  parts.push(`
<environment>
Working directory: ${env.working_directory()}
Platform: ${env.platform()}
OS version: ${env.os_version()}
Today's date: ${new Date().toISOString().split('T')[0]}
</environment>`);

  // Project docs
  if (projectDocs) {
    parts.push(`
<project-instructions>
${projectDocs}
</project-instructions>`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// OpenAI Profile Factory
// ---------------------------------------------------------------------------

export function createOpenAIProfile(
  model: string = 'gpt-5.2-codex',
  overrides?: Partial<ProviderProfile>,
): ProviderProfile {
  const registry = new ToolRegistry();

  // Register codex-rs aligned tools
  registry.register(readFileTool);
  registry.register(applyPatchTool);
  registry.register(writeFileTool);
  registry.register(shellTool);
  registry.register(grepTool);
  registry.register(globTool);

  // Register subagent tool definitions (executors wired up by Session when SubAgentManager is available)
  for (const def of SUBAGENT_TOOL_DEFINITIONS) {
    registry.register({
      definition: def,
      executor: async () => { throw new Error(`Subagent tool '${def.name}' not wired up. Use Session to initialize subagent support.`); },
    });
  }

  const profile: ProviderProfile = {
    id: 'openai',
    model,
    tool_registry: registry,

    build_system_prompt: buildOpenAISystemPrompt,
    tools: () => registry.definitions(),
    provider_options: () => null,

    supports_reasoning: true,
    supports_streaming: true,
    supports_parallel_tool_calls: true,
    context_window_size: 1_047_576,

    ...overrides,
  };

  return profile;
}
