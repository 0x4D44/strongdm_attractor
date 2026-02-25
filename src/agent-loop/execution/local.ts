/**
 * LocalExecutionEnvironment — runs tools on the local machine.
 *
 * Implements file operations via Node.js fs/promises,
 * command execution via child_process with timeout, SIGTERM/SIGKILL,
 * environment variable filtering, and search operations.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import type {
  ExecutionEnvironment,
  ExecResult,
  DirEntry,
  GrepOptions,
} from '../types.js';

/** Patterns for env vars to exclude by default (case-insensitive) */
const SENSITIVE_PATTERNS = [
  /_API_KEY$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
  /_PASSWORD$/i,
  /_CREDENTIAL$/i,
];

/** Env vars to always include */
const SAFE_VARS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'GOPATH',
  'CARGO_HOME',
  'NVM_DIR',
  'RUSTUP_HOME',
  'JAVA_HOME',
  'PYTHONPATH',
  'NODE_PATH',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'EDITOR',
  'VISUAL',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'SSH_AUTH_SOCK',
  'GPG_TTY',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'PWD',
  'OLDPWD',
  'SHLVL',
  'HOSTNAME',
  'LOGNAME',
]);

export type EnvVarPolicy = 'inherit_all' | 'inherit_none' | 'inherit_core';

export interface LocalExecutionOptions {
  workingDirectory: string;
  envVarPolicy?: EnvVarPolicy;
  defaultCommandTimeoutMs?: number;
  maxCommandTimeoutMs?: number;
}

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  private _workDir: string;
  private _envVarPolicy: EnvVarPolicy;
  private _defaultTimeout: number;
  private _maxTimeout: number;

  constructor(options: LocalExecutionOptions) {
    this._workDir = path.resolve(options.workingDirectory);
    this._envVarPolicy = options.envVarPolicy ?? 'inherit_core';
    this._defaultTimeout = options.defaultCommandTimeoutMs ?? 10_000;
    this._maxTimeout = options.maxCommandTimeoutMs ?? 600_000;
  }

  // -----------------------------------------------------------------------
  // File Operations
  // -----------------------------------------------------------------------

  async read_file(
    filePath: string,
    offset?: number | null,
    limit?: number | null,
  ): Promise<string> {
    const resolved = this._resolve(filePath);
    const content = await fs.readFile(resolved, 'utf-8');
    const lines = content.split('\n');

    const startLine = offset ? Math.max(0, offset - 1) : 0;
    const maxLines = limit ?? 2000;
    const endLine = Math.min(lines.length, startLine + maxLines);
    const selected = lines.slice(startLine, endLine);

    // Return raw content — line-number formatting is done in the tool executor
    return selected.join('\n');
  }

  async write_file(filePath: string, content: string): Promise<void> {
    const resolved = this._resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf-8');
  }

  async file_exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(this._resolve(filePath));
      return true;
    } catch {
      return false;
    }
  }

  async list_directory(dirPath: string, depth: number): Promise<DirEntry[]> {
    const resolved = this._resolve(dirPath);
    return this._listDirRecursive(resolved, depth);
  }

  private async _listDirRecursive(
    dirPath: string,
    depth: number,
  ): Promise<DirEntry[]> {
    if (depth < 0) return [];
    const entries: DirEntry[] = [];
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });

    for (const dirent of dirents) {
      const fullPath = path.join(dirPath, dirent.name);
      let size: number | null = null;
      if (!dirent.isDirectory()) {
        try {
          const stat = await fs.stat(fullPath);
          size = stat.size;
        } catch { /* v8 ignore next -- stat error: broken symlink or permission issue */
        }
      }
      entries.push({
        name: dirent.name,
        is_dir: dirent.isDirectory(),
        size,
      });

      if (dirent.isDirectory() && depth > 1) {
        const subEntries = await this._listDirRecursive(
          fullPath,
          depth - 1,
        );
        for (const sub of subEntries) {
          entries.push({
            ...sub,
            name: `${dirent.name}/${sub.name}`,
          });
        }
      }
    }

    return entries;
  }

  // -----------------------------------------------------------------------
  // Command Execution
  // -----------------------------------------------------------------------

  async exec_command(
    command: string,
    timeout_ms: number,
    working_dir?: string | null,
    env_vars?: Record<string, string> | null,
  ): Promise<ExecResult> {
    const effectiveTimeout = Math.min(
      timeout_ms > 0 ? timeout_ms : this._defaultTimeout,
      this._maxTimeout,
    );
    const cwd = working_dir
      ? this._resolve(working_dir)
      : this._workDir;

    const filteredEnv = this._filterEnv(env_vars ?? undefined);

    return new Promise<ExecResult>((resolve) => {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      /* v8 ignore next 3 -- platform-specific: only one branch taken per OS */
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArgs =
        process.platform === 'win32' ? ['/c', command] : ['-c', command];

      const child = spawn(shell, shellArgs, {
        cwd,
        env: filteredEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // new process group
      });

      /* v8 ignore next 3 -- settled guard: only fires in race between close+error or kill-timer+close */
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        resolve({
          stdout,
          stderr,
          exit_code: exitCode,
          timed_out: timedOut,
          duration_ms: Date.now() - startTime,
        });
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        finish(code ?? 1);
      });
      /* v8 ignore next 4 -- spawn error: fires only for invalid shell path or permissions */
      child.on('error', (err) => {
        stderr += err.message;
        finish(1);
      });

      // Timeout handling: SIGTERM -> wait 2s -> SIGKILL
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) {
            process.kill(-child.pid, 'SIGTERM');
          }
        } catch { /* v8 ignore next -- SIGTERM race: process already exited */
        }
        /* v8 ignore next 10 -- SIGKILL escalation: only fires if process ignores SIGTERM for >2s */
        killTimer = setTimeout(() => {
          try {
            if (child.pid) {
              process.kill(-child.pid, 'SIGKILL');
            }
          } catch {
            // process may have already exited
          }
          // Force finish if process still hasn't closed
          finish(137);
        }, 2000);
      }, effectiveTimeout);

      // Clean up timeout if process exits normally
      child.on('close', () => {
        clearTimeout(timeoutTimer);
      });
    });
  }

  // -----------------------------------------------------------------------
  // Search Operations
  // -----------------------------------------------------------------------

  async grep(
    pattern: string,
    searchPath: string,
    options: GrepOptions,
  ): Promise<string> {
    const resolved = this._resolve(searchPath);
    const args: string[] = [];

    // Try ripgrep first, fall back to grep
    const useRipgrep = await this._commandExists('rg');
    /* v8 ignore next -- ripgrep availability: only one branch taken per environment */
    const cmd = useRipgrep ? 'rg' : 'grep';

    if (options.case_insensitive) args.push('-i');
    /* v8 ignore next 9 -- ripgrep-specific args: only taken when rg is installed */
    if (useRipgrep) {
      args.push('-n'); // line numbers
      args.push('--no-heading');
      if (options.max_results) {
        args.push('-m', String(options.max_results));
      }
      if (options.glob_filter) {
        args.push('-g', options.glob_filter);
      }
    } else {
      args.push('-rn'); // recursive, line numbers
      if (options.glob_filter) {
        args.push('--include', options.glob_filter);
      }
    }

    args.push('--', pattern, resolved);

    const result = await this.exec_command(
      `${cmd} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`,
      30_000,
    );

    if (result.exit_code === 1 && !result.stdout.trim()) {
      return 'No matches found.';
    }

    /* v8 ignore next -- stderr/no-output fallbacks: only taken when grep writes to stderr or produces no output */
    return result.stdout || result.stderr || 'No matches found.';
  }

  async glob(pattern: string, basePath?: string): Promise<string[]> {
    const resolved = basePath
      ? this._resolve(basePath)
      : this._workDir;

    // Use dynamic import for Node.js 22+ fs.glob, with fallback for older versions
    try {
      const fsPromises = await import('node:fs/promises');
      const globFn = (fsPromises as Record<string, unknown>).glob as
        | ((pattern: string, opts: { cwd: string }) => AsyncIterable<string>)
        | undefined;
      /* v8 ignore next -- glob availability: Node version dependent */
      if (!globFn) throw new Error('glob not available');
      const results: string[] = [];
      for await (const entry of globFn(pattern, { cwd: resolved })) {
        results.push(path.join(resolved, entry));
      }

      // Sort by modification time (newest first)
      const withStats = await Promise.all(
        results.map(async (p) => {
          try {
            const stat = await fs.stat(p);
            return { path: p, mtime: stat.mtimeMs };
          } catch { /* v8 ignore next -- stat race: file deleted between glob and stat */
            return { path: p, mtime: 0 };
          }
        }),
      );
      withStats.sort((a, b) => b.mtime - a.mtime);
      return withStats.map((w) => w.path);
    } catch { /* v8 ignore next 8 -- glob fallback: only fires on Node <22 where fs.glob is unavailable */
      const result = await this.exec_command(
        `find "${resolved}" -name "${pattern}" -type f 2>/dev/null | head -500`,
        10_000,
      );
      return result.stdout
        .split('\n')
        .filter((l) => l.trim() !== '');
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    // Verify working directory exists
    await fs.access(this._workDir);
  }

  async cleanup(): Promise<void> {
    // Nothing to clean up for local
  }

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  working_directory(): string {
    return this._workDir;
  }

  platform(): string {
    return process.platform;
  }

  os_version(): string {
    return `${os.type()} ${os.release()}`;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private _resolve(p: string): string {
    if (path.isAbsolute(p)) return p;
    return path.resolve(this._workDir, p);
  }

  private _filterEnv(
    extraVars?: Record<string, string>,
  ): Record<string, string> {
    const env: Record<string, string> = {};

    if (this._envVarPolicy === 'inherit_all') {
      Object.assign(env, process.env);
    } else if (this._envVarPolicy === 'inherit_core') {
      for (const [key, value] of Object.entries(process.env)) {
        /* v8 ignore next -- Object.entries never yields undefined values for process.env on Node 20+ */
        if (value === undefined) continue;
        if (SAFE_VARS.has(key)) {
          env[key] = value;
          continue;
        }
        // Exclude sensitive patterns
        const isSensitive = SENSITIVE_PATTERNS.some((pat) =>
          pat.test(key),
        );
        if (!isSensitive) {
          env[key] = value;
        }
      }
    }
    // inherit_none: start clean

    // Apply extra vars
    if (extraVars) {
      Object.assign(env, extraVars);
    }

    return env;
  }

  private async _commandExists(cmd: string): Promise<boolean> {
    try {
      const result = await this.exec_command(
        `command -v ${cmd}`,
        2000,
      );
      return result.exit_code === 0;
    } catch { /* v8 ignore next -- exec_command doesn't throw; it resolves with exit_code */
      return false;
    }
  }
}
