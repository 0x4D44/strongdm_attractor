/**
 * Shared core tools: provider-agnostic base tool implementations.
 * These are registered by each provider profile.
 */

import type {
  RegisteredTool,
  ToolDefinition,
  ExecutionEnvironment,
} from '../types.js';

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const readFileDefinition: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a file from the filesystem. Returns line-numbered content in "NNN | content" format.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to read.',
      },
      offset: {
        type: 'integer',
        description: '1-based line number to start reading from.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of lines to read (default: 2000).',
      },
    },
    required: ['file_path'],
  },
};

/** Add "NNN | " line-number prefixes for LLM display. */
export function addLineNumbers(content: string, startLine: number = 1): string {
  const lines = content.split('\n');
  const lastLineNum = startLine + lines.length - 1;
  const width = String(lastLineNum).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)} | ${line}`)
    .join('\n');
}

async function readFileExecutor(
  args: Record<string, unknown>,
  env: ExecutionEnvironment,
): Promise<string> {
  const filePath = args.file_path as string;
  const offset = (args.offset as number | undefined) ?? null;
  const limit = (args.limit as number | undefined) ?? null;
  const raw = await env.read_file(filePath, offset, limit);
  const startLine = offset ?? 1;
  return addLineNumbers(raw, startLine);
}

export const readFileTool: RegisteredTool = {
  definition: readFileDefinition,
  executor: readFileExecutor,
};

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

const writeFileDefinition: ToolDefinition = {
  name: 'write_file',
  description:
    'Write content to a file. Creates the file and parent directories if needed.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to write.',
      },
      content: {
        type: 'string',
        description: 'The full file content to write.',
      },
    },
    required: ['file_path', 'content'],
  },
};

async function writeFileExecutor(
  args: Record<string, unknown>,
  env: ExecutionEnvironment,
): Promise<string> {
  const filePath = args.file_path as string;
  const content = args.content as string;
  await env.write_file(filePath, content);
  const bytes = Buffer.byteLength(content, 'utf-8');
  return `Successfully wrote ${bytes} bytes to ${filePath}`;
}

export const writeFileTool: RegisteredTool = {
  definition: writeFileDefinition,
  executor: writeFileExecutor,
};

// ---------------------------------------------------------------------------
// edit_file (old_string / new_string)
// ---------------------------------------------------------------------------

const editFileDefinition: ToolDefinition = {
  name: 'edit_file',
  description:
    'Replace an exact string occurrence in a file. The old_string must match exactly.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the file to edit.',
      },
      old_string: {
        type: 'string',
        description: 'Exact text to find in the file.',
      },
      new_string: {
        type: 'string',
        description: 'Replacement text.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default: false).',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
};

async function editFileExecutor(
  args: Record<string, unknown>,
  env: ExecutionEnvironment,
): Promise<string> {
  const filePath = args.file_path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;
  const replaceAll = (args.replace_all as boolean) ?? false;

  const content = await env.read_file(filePath);

  if (!content.includes(oldString)) {
    // Attempt fuzzy match: normalize whitespace
    const normalizeWs = (s: string) => s.replace(/\s+/g, ' ').trim();
    const normalizedContent = normalizeWs(content);
    const normalizedOld = normalizeWs(oldString);
    if (normalizedContent.includes(normalizedOld)) {
      throw new Error(
        `Exact match not found for old_string, but a whitespace-normalized match exists. ` +
          `Please provide the exact string including whitespace.`,
      );
    }
    throw new Error(
      `old_string not found in ${filePath}. Read the file first to get the exact content.`,
    );
  }

  if (!replaceAll) {
    const firstIdx = content.indexOf(oldString);
    const secondIdx = content.indexOf(oldString, firstIdx + 1);
    if (secondIdx !== -1) {
      throw new Error(
        `old_string matches multiple locations in ${filePath}. ` +
          `Provide more context to make it unique, or set replace_all=true.`,
      );
    }
  }

  let newContent: string;
  let count: number;

  if (replaceAll) {
    const parts = content.split(oldString);
    count = parts.length - 1;
    newContent = parts.join(newString);
  } else {
    newContent = content.replace(oldString, newString);
    count = 1;
  }

  await env.write_file(filePath, newContent);
  return `Successfully replaced ${count} occurrence(s) in ${filePath}`;
}

export const editFileTool: RegisteredTool = {
  definition: editFileDefinition,
  executor: editFileExecutor,
};

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

const shellDefinition: ToolDefinition = {
  name: 'shell',
  description:
    'Execute a shell command. Returns stdout, stderr, and exit code.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to run.',
      },
      timeout_ms: {
        type: 'integer',
        description: 'Override default timeout in milliseconds.',
      },
      description: {
        type: 'string',
        description: 'Human-readable description of what this command does.',
      },
    },
    required: ['command'],
  },
};

async function shellExecutor(
  args: Record<string, unknown>,
  env: ExecutionEnvironment,
): Promise<string> {
  const command = args.command as string;
  const timeoutMs = args.timeout_ms as number | undefined;
  // timeout is resolved in the session loop; here we pass it through
  const timeout = timeoutMs ?? 0; // 0 means "use session default"

  const result = await env.exec_command(command, timeout);

  const parts: string[] = [];
  if (result.stdout) {
    parts.push(result.stdout);
  }
  if (result.stderr) {
    parts.push(`[stderr]\n${result.stderr}`);
  }

  const output = parts.join('\n') || '(no output)';

  if (result.timed_out) {
    return (
      output +
      `\n\n[ERROR: Command timed out after ${result.duration_ms}ms. Partial output is shown above.\n` +
      `You can retry with a longer timeout by setting the timeout_ms parameter.]`
    );
  }

  if (result.exit_code !== 0) {
    return output + `\n\n[Exit code: ${result.exit_code}]`;
  }

  return output;
}

export const shellTool: RegisteredTool = {
  definition: shellDefinition,
  executor: shellExecutor,
};

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const grepDefinition: ToolDefinition = {
  name: 'grep',
  description: 'Search file contents using regex patterns.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for.',
      },
      path: {
        type: 'string',
        description:
          'Directory or file to search (default: working directory).',
      },
      glob_filter: {
        type: 'string',
        description: 'File pattern filter (e.g., "*.py").',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case insensitive search (default: false).',
      },
      max_results: {
        type: 'integer',
        description: 'Maximum number of results (default: 100).',
      },
    },
    required: ['pattern'],
  },
};

async function grepExecutor(
  args: Record<string, unknown>,
  env: ExecutionEnvironment,
): Promise<string> {
  const pattern = args.pattern as string;
  const path = (args.path as string | undefined) ?? env.working_directory();
  const globFilter = args.glob_filter as string | undefined;
  const caseInsensitive = (args.case_insensitive as boolean) ?? false;
  const maxResults = (args.max_results as number) ?? 100;

  return env.grep(pattern, path, {
    glob_filter: globFilter,
    case_insensitive: caseInsensitive,
    max_results: maxResults,
  });
}

export const grepTool: RegisteredTool = {
  definition: grepDefinition,
  executor: grepExecutor,
};

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

const globDefinition: ToolDefinition = {
  name: 'glob',
  description: 'Find files matching a glob pattern.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern (e.g., "**/*.ts").',
      },
      path: {
        type: 'string',
        description: 'Base directory (default: working directory).',
      },
    },
    required: ['pattern'],
  },
};

async function globExecutor(
  args: Record<string, unknown>,
  env: ExecutionEnvironment,
): Promise<string> {
  const pattern = args.pattern as string;
  const path = args.path as string | undefined;
  const files = await env.glob(pattern, path);
  if (files.length === 0) {
    return 'No files found matching the pattern.';
  }
  return files.join('\n');
}

export const globTool: RegisteredTool = {
  definition: globDefinition,
  executor: globExecutor,
};

// ---------------------------------------------------------------------------
// Export all shared tools as an array
// ---------------------------------------------------------------------------

export const SHARED_TOOLS: RegisteredTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  shellTool,
  grepTool,
  globTool,
];
