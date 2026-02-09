/**
 * Gemini Provider Profile — gemini-cli aligned.
 *
 * Provides read_file, read_many_files, write_file, edit_file, shell, grep, glob,
 * list_dir, web_search (optional), web_fetch (optional).
 * System prompt mirrors gemini-cli style.
 */

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
  editFileTool,
  shellTool,
  grepTool,
  globTool,
  addLineNumbers,
} from './shared.js';
import { SUBAGENT_TOOL_DEFINITIONS } from '../subagent.js';

// ---------------------------------------------------------------------------
// Gemini-specific tools
// ---------------------------------------------------------------------------

// read_many_files — batch reading support
const readManyFilesDefinition: ToolDefinition = {
  name: 'read_many_files',
  description: 'Read multiple files at once. Returns contents of all files with line numbers.',
  parameters: {
    type: 'object',
    properties: {
      file_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of absolute file paths to read.',
      },
    },
    required: ['file_paths'],
  },
};

async function readManyFilesExecutor(
  args: Record<string, unknown>,
  env: ExecutionEnvironment,
): Promise<string> {
  const paths = args.file_paths as string[];
  const results: string[] = [];

  for (const filePath of paths) {
    try {
      const content = await env.read_file(filePath);
      results.push(`=== ${filePath} ===\n${addLineNumbers(content)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`=== ${filePath} ===\n[Error: ${msg}]`);
    }
  }

  return results.join('\n\n');
}

const readManyFilesTool: RegisteredTool = {
  definition: readManyFilesDefinition,
  executor: readManyFilesExecutor,
};

// list_dir — directory listing with depth
const listDirDefinition: ToolDefinition = {
  name: 'list_dir',
  description: 'List directory contents with configurable depth.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path to list.',
      },
      depth: {
        type: 'integer',
        description: 'Maximum depth to recurse (default: 1).',
      },
    },
    required: ['path'],
  },
};

async function listDirExecutor(
  args: Record<string, unknown>,
  env: ExecutionEnvironment,
): Promise<string> {
  const path = args.path as string;
  const depth = (args.depth as number) ?? 1;
  const entries = await env.list_directory(path, depth);
  if (entries.length === 0) {
    return 'Directory is empty.';
  }
  return entries
    .map((e) => {
      const suffix = e.is_dir ? '/' : '';
      const size = e.size !== null ? ` (${e.size} bytes)` : '';
      return `${e.name}${suffix}${size}`;
    })
    .join('\n');
}

const listDirTool: RegisteredTool = {
  definition: listDirDefinition,
  executor: listDirExecutor,
};

// web_search (optional)
const webSearchDefinition: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web for information. Returns search results.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query.',
      },
    },
    required: ['query'],
  },
};

async function webSearchExecutor(
  args: Record<string, unknown>,
  env: ExecutionEnvironment,
): Promise<string> {
  const query = args.query as string;
  // Placeholder: in a real implementation, this would use Gemini's grounding API or a search provider
  return `[Web search not implemented in execution environment. Query: "${query}"]`;
}

const webSearchTool: RegisteredTool = {
  definition: webSearchDefinition,
  executor: webSearchExecutor,
};

// web_fetch (optional)
const webFetchDefinition: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch and extract content from a URL.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to fetch.',
      },
    },
    required: ['url'],
  },
};

async function webFetchExecutor(
  args: Record<string, unknown>,
  _env: ExecutionEnvironment,
): Promise<string> {
  const url = args.url as string;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch URL (${response.status}): ${response.statusText}`);
  }
  const text = await response.text();
  return text.slice(0, 50000);
}

const webFetchTool: RegisteredTool = {
  definition: webFetchDefinition,
  executor: webFetchExecutor,
};

// ---------------------------------------------------------------------------
// Gemini System Prompt
// ---------------------------------------------------------------------------

function buildGeminiSystemPrompt(
  env: ExecutionEnvironment,
  projectDocs: string,
): string {
  const parts: string[] = [];

  // Base instructions (gemini-cli style)
  parts.push(`You are a coding assistant. You help users with programming tasks by reading, writing, and editing code files, and by running commands.

## Tool Usage
- Use read_file or read_many_files to examine code before making changes.
- Use write_file to create new files. Use edit_file to modify existing files.
- Use shell to run commands like build, test, lint, git, etc.
- Use grep to search code. Use glob to find files. Use list_dir to explore directories.
- Use web_search and web_fetch when you need information from the internet.

## Best Practices
- Always read relevant files before editing them.
- Make focused, minimal changes. Avoid rewriting entire files unnecessarily.
- Verify changes by running tests or build commands after edits.
- If a command fails, analyze the error output and fix the root cause.
- When searching for code, start with grep or glob to locate relevant files.
- Explain your reasoning before making changes.`);

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
// Gemini Profile Factory
// ---------------------------------------------------------------------------

export function createGeminiProfile(
  model: string = 'gemini-3-flash-preview',
  overrides?: Partial<ProviderProfile>,
): ProviderProfile {
  const registry = new ToolRegistry();

  // Register gemini-cli aligned tools
  registry.register(readFileTool);
  registry.register(readManyFilesTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(shellTool);
  registry.register(grepTool);
  registry.register(globTool);
  registry.register(listDirTool);
  registry.register(webSearchTool);
  registry.register(webFetchTool);

  // Register subagent tool definitions (executors wired up by Session when SubAgentManager is available)
  for (const def of SUBAGENT_TOOL_DEFINITIONS) {
    registry.register({
      definition: def,
      executor: async () => { throw new Error(`Subagent tool '${def.name}' not wired up. Use Session to initialize subagent support.`); },
    });
  }

  const profile: ProviderProfile = {
    id: 'gemini',
    model,
    tool_registry: registry,

    build_system_prompt: buildGeminiSystemPrompt,
    tools: () => registry.definitions(),
    provider_options: () => ({
      gemini: {
        safety_settings: [],
      },
    }),

    supports_reasoning: true,
    supports_streaming: true,
    supports_parallel_tool_calls: true,
    context_window_size: 1_048_576,

    ...overrides,
  };

  return profile;
}
