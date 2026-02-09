/**
 * Anthropic Provider Profile — Claude Code aligned.
 *
 * Provides edit_file (old_string/new_string), read_file, write_file, shell, grep, glob.
 * System prompt mirrors Claude Code style.
 */

import type {
  ProviderProfile,
  ToolDefinition,
  ExecutionEnvironment,
} from '../types.js';
import { ToolRegistry } from './registry.js';
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  shellTool,
  grepTool,
  globTool,
} from './shared.js';
import { SUBAGENT_TOOL_DEFINITIONS } from '../subagent.js';

// ---------------------------------------------------------------------------
// Anthropic-specific shell with 120s default timeout
// ---------------------------------------------------------------------------

const anthropicShellDefinition: ToolDefinition = {
  name: 'shell',
  description:
    'Execute a shell command. Returns stdout, stderr, and exit code. Default timeout is 120 seconds.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to run.',
      },
      timeout_ms: {
        type: 'integer',
        description: 'Override default timeout in milliseconds (default: 120000).',
      },
      description: {
        type: 'string',
        description: 'Human-readable description of what this command does.',
      },
    },
    required: ['command'],
  },
};

// ---------------------------------------------------------------------------
// Anthropic System Prompt
// ---------------------------------------------------------------------------

function buildAnthropicSystemPrompt(
  env: ExecutionEnvironment,
  projectDocs: string,
): string {
  const parts: string[] = [];

  // Base instructions (Claude Code style)
  parts.push(`You are an interactive agent that assists with software engineering tasks. Use the tools provided to help the user.

## Tool Usage Guidelines
- Use read_file to read files before editing them. Understand existing code before suggesting modifications.
- Use edit_file with old_string/new_string for modifying existing files. The old_string must be unique in the file — if it matches multiple locations, provide more context to disambiguate.
- Use write_file only for creating new files. Prefer editing existing files over creating new ones.
- Use shell to run commands. Check exit codes and stderr for errors.
- Use grep to search file contents. Use glob to find files by name pattern.

## edit_file Format
The edit_file tool performs exact string replacement:
- old_string: The exact text to find in the file (must be unique)
- new_string: The replacement text
- If old_string is not unique, the tool returns an error. Provide a larger context string.
- Set replace_all=true to replace all occurrences.

## Best Practices
- Read files before editing them. Never edit a file you haven't read.
- Make targeted, minimal edits. Don't rewrite entire files when a focused edit suffices.
- After making changes, run relevant tests or build commands to verify correctness.
- If a command fails, read the error carefully and fix the underlying issue.
- Prefer editing existing files over creating new ones to avoid file bloat.
- Do not add unnecessary comments, docstrings, or type annotations to code you didn't change.`);

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
// Anthropic Profile Factory
// ---------------------------------------------------------------------------

export function createAnthropicProfile(
  model: string = 'claude-opus-4-6',
  overrides?: Partial<ProviderProfile>,
): ProviderProfile {
  const registry = new ToolRegistry();

  // Register Claude Code aligned tools
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  // Override shell with Anthropic-specific 120s default timeout
  registry.register({
    definition: anthropicShellDefinition,
    executor: async (args, env) => {
      // Default to 120s when no timeout is specified by the LLM
      if (args.timeout_ms === undefined || args.timeout_ms === null || args.timeout_ms === 0) {
        args = { ...args, timeout_ms: 120_000 };
      }
      return shellTool.executor(args, env);
    },
  });
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
    id: 'anthropic',
    model,
    tool_registry: registry,

    build_system_prompt: buildAnthropicSystemPrompt,
    tools: () => registry.definitions(),
    provider_options: () => ({
      anthropic: {
        beta_headers: [
          'interleaved-thinking-2025-05-14',
          'token-efficient-tools-2025-02-19',
        ],
      },
    }),

    supports_reasoning: true,
    supports_streaming: true,
    supports_parallel_tool_calls: false,
    context_window_size: 200_000,

    ...overrides,
  };

  return profile;
}
