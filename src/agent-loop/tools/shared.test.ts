import { describe, it, expect, vi } from 'vitest';
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  shellTool,
  grepTool,
  globTool,
  addLineNumbers,
} from './shared.js';
import type {
  ExecutionEnvironment,
  ExecResult,
  DirEntry,
  GrepOptions,
} from '../types.js';

/** In-memory mock execution environment */
class MockExecutionEnvironment implements ExecutionEnvironment {
  private files = new Map<string, string>();
  private _workDir = '/mock/workspace';
  private _grepResult = 'No matches found.';
  private _globResult: string[] = [];
  private _execResult: ExecResult = {
    stdout: '',
    stderr: '',
    exit_code: 0,
    timed_out: false,
    duration_ms: 10,
  };

  constructor(files?: Record<string, string>) {
    if (files) {
      for (const [k, v] of Object.entries(files)) {
        this.files.set(k, v);
      }
    }
  }

  setGrepResult(result: string): void {
    this._grepResult = result;
  }

  setGlobResult(result: string[]): void {
    this._globResult = result;
  }

  setExecResult(result: Partial<ExecResult>): void {
    this._execResult = { ...this._execResult, ...result };
  }

  async read_file(
    path: string,
    offset?: number | null,
    limit?: number | null,
  ): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    const lines = content.split('\n');
    const startLine = offset ? Math.max(0, offset - 1) : 0;
    const maxLines = limit ?? 2000;
    const endLine = Math.min(lines.length, startLine + maxLines);
    return lines.slice(startLine, endLine).join('\n');
  }

  async write_file(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async file_exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async list_directory(path: string, depth: number): Promise<DirEntry[]> {
    return [];
  }

  async exec_command(
    command: string,
    timeout_ms: number,
  ): Promise<ExecResult> {
    return this._execResult;
  }

  async grep(
    pattern: string,
    path: string,
    options: GrepOptions,
  ): Promise<string> {
    return this._grepResult;
  }

  async glob(pattern: string, path?: string): Promise<string[]> {
    return this._globResult;
  }

  async initialize(): Promise<void> {}
  async cleanup(): Promise<void> {}
  working_directory(): string {
    return this._workDir;
  }
  platform(): string {
    return 'linux';
  }
  os_version(): string {
    return 'Linux 6.0';
  }

  getFile(path: string): string | undefined {
    return this.files.get(path);
  }
}

describe('addLineNumbers', () => {
  it('adds line numbers starting from 1', () => {
    const result = addLineNumbers('a\nb\nc');
    expect(result).toBe('1 | a\n2 | b\n3 | c');
  });

  it('pads line numbers for alignment', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const result = addLineNumbers(lines.join('\n'));
    expect(result).toContain(' 1 | line1');
    expect(result).toContain('10 | line10');
  });

  it('respects startLine parameter', () => {
    const result = addLineNumbers('a\nb', 5);
    expect(result).toBe('5 | a\n6 | b');
  });
});

describe('readFileTool', () => {
  it('reads file and adds line numbers', async () => {
    const env = new MockExecutionEnvironment({
      '/foo/bar.txt': 'hello\nworld',
    });
    const result = await readFileTool.executor(
      { file_path: '/foo/bar.txt' },
      env,
    );
    expect(result).toBe('1 | hello\n2 | world');
  });

  it('respects offset parameter', async () => {
    const env = new MockExecutionEnvironment({
      '/foo/bar.txt': 'line1\nline2\nline3\nline4',
    });
    const result = await readFileTool.executor(
      { file_path: '/foo/bar.txt', offset: 2 },
      env,
    );
    expect(result).toContain('2 | line2');
    expect(result).not.toContain('line1');
  });

  it('throws on missing file', async () => {
    const env = new MockExecutionEnvironment();
    await expect(
      readFileTool.executor({ file_path: '/nonexistent' }, env),
    ).rejects.toThrow('File not found');
  });
});

describe('writeFileTool', () => {
  it('writes content and returns confirmation', async () => {
    const env = new MockExecutionEnvironment();
    const result = await writeFileTool.executor(
      { file_path: '/foo/out.txt', content: 'hello world' },
      env,
    );
    expect(result).toContain('Successfully wrote');
    expect(result).toContain('11 bytes');
    expect(env.getFile('/foo/out.txt')).toBe('hello world');
  });
});

describe('editFileTool', () => {
  it('finds old_string and replaces with new_string', async () => {
    const env = new MockExecutionEnvironment({
      '/foo/file.ts': 'const x = 1;\nconst y = 2;',
    });
    const result = await editFileTool.executor(
      {
        file_path: '/foo/file.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 42;',
      },
      env,
    );
    expect(result).toContain('Successfully replaced 1 occurrence');
    expect(env.getFile('/foo/file.ts')).toBe('const x = 42;\nconst y = 2;');
  });

  it('old_string not found -> error', async () => {
    const env = new MockExecutionEnvironment({
      '/foo/file.ts': 'const x = 1;',
    });
    await expect(
      editFileTool.executor(
        {
          file_path: '/foo/file.ts',
          old_string: 'not in file',
          new_string: 'replacement',
        },
        env,
      ),
    ).rejects.toThrow('old_string not found');
  });

  it('old_string not unique -> error', async () => {
    const env = new MockExecutionEnvironment({
      '/foo/file.ts': 'foo\nbar\nfoo',
    });
    await expect(
      editFileTool.executor(
        {
          file_path: '/foo/file.ts',
          old_string: 'foo',
          new_string: 'baz',
        },
        env,
      ),
    ).rejects.toThrow('matches multiple locations');
  });

  it('replace_all replaces all occurrences', async () => {
    const env = new MockExecutionEnvironment({
      '/foo/file.ts': 'foo\nbar\nfoo',
    });
    const result = await editFileTool.executor(
      {
        file_path: '/foo/file.ts',
        old_string: 'foo',
        new_string: 'baz',
        replace_all: true,
      },
      env,
    );
    expect(result).toContain('2 occurrence(s)');
    expect(env.getFile('/foo/file.ts')).toBe('baz\nbar\nbaz');
  });

  it('whitespace-normalized match gives helpful error', async () => {
    const env = new MockExecutionEnvironment({
      '/foo/file.ts': 'const  x  =  1;',
    });
    await expect(
      editFileTool.executor(
        {
          file_path: '/foo/file.ts',
          old_string: 'const x = 1;',
          new_string: 'const x = 2;',
        },
        env,
      ),
    ).rejects.toThrow('whitespace-normalized match exists');
  });
});

describe('shellTool', () => {
  it('executes command and returns stdout', async () => {
    const env = new MockExecutionEnvironment();
    env.setExecResult({ stdout: 'hello\n', stderr: '', exit_code: 0 });
    const result = await shellTool.executor(
      { command: 'echo hello' },
      env,
    );
    expect(result).toBe('hello\n');
  });

  it('includes stderr when present', async () => {
    const env = new MockExecutionEnvironment();
    env.setExecResult({
      stdout: '',
      stderr: 'warning: something',
      exit_code: 0,
    });
    const result = await shellTool.executor(
      { command: 'some-cmd' },
      env,
    );
    expect(result).toContain('[stderr]');
    expect(result).toContain('warning: something');
  });

  it('returns (no output) when stdout and stderr are empty', async () => {
    const env = new MockExecutionEnvironment();
    env.setExecResult({ stdout: '', stderr: '', exit_code: 0 });
    const result = await shellTool.executor(
      { command: 'true' },
      env,
    );
    expect(result).toBe('(no output)');
  });

  it('includes exit code on non-zero exit', async () => {
    const env = new MockExecutionEnvironment();
    env.setExecResult({ stdout: 'error output', exit_code: 1 });
    const result = await shellTool.executor(
      { command: 'false' },
      env,
    );
    expect(result).toContain('[Exit code: 1]');
  });

  it('shows timeout message on timed_out', async () => {
    const env = new MockExecutionEnvironment();
    env.setExecResult({
      stdout: 'partial',
      timed_out: true,
      duration_ms: 5000,
    });
    const result = await shellTool.executor(
      { command: 'sleep 100' },
      env,
    );
    expect(result).toContain('timed out');
    expect(result).toContain('5000ms');
  });
});

describe('grepTool', () => {
  it('searches pattern in files', async () => {
    const env = new MockExecutionEnvironment();
    env.setGrepResult('file.ts:10:const x = 1;');
    const result = await grepTool.executor(
      { pattern: 'const x' },
      env,
    );
    expect(result).toBe('file.ts:10:const x = 1;');
  });

  it('uses working_directory as default path', async () => {
    const env = new MockExecutionEnvironment();
    const grepSpy = vi.spyOn(env, 'grep');
    env.setGrepResult('No matches found.');
    await grepTool.executor({ pattern: 'hello' }, env);
    expect(grepSpy).toHaveBeenCalledWith(
      'hello',
      '/mock/workspace',
      expect.objectContaining({ case_insensitive: false, max_results: 100 }),
    );
  });
});

describe('globTool', () => {
  it('lists matching files', async () => {
    const env = new MockExecutionEnvironment();
    env.setGlobResult(['/mock/workspace/a.ts', '/mock/workspace/b.ts']);
    const result = await globTool.executor(
      { pattern: '*.ts' },
      env,
    );
    expect(result).toBe(
      '/mock/workspace/a.ts\n/mock/workspace/b.ts',
    );
  });

  it('returns message when no files found', async () => {
    const env = new MockExecutionEnvironment();
    env.setGlobResult([]);
    const result = await globTool.executor(
      { pattern: '*.xyz' },
      env,
    );
    expect(result).toBe('No files found matching the pattern.');
  });
});
