import { describe, it, expect, vi } from 'vitest';
import { createGeminiProfile } from './gemini-profile.js';
import type { ExecutionEnvironment } from '../types.js';

function makeEnv(overrides: Partial<ExecutionEnvironment> = {}): ExecutionEnvironment {
  return {
    read_file: vi.fn().mockResolvedValue('line1\nline2\n'),
    write_file: vi.fn().mockResolvedValue(undefined),
    file_exists: vi.fn().mockResolvedValue(false),
    list_directory: vi.fn().mockResolvedValue([
      { name: 'file.ts', is_dir: false, size: 100 },
      { name: 'subdir', is_dir: true, size: null },
    ]),
    exec_command: vi.fn().mockResolvedValue({
      stdout: '', stderr: '', exit_code: 0, timed_out: false, duration_ms: 0,
    }),
    grep: vi.fn().mockResolvedValue('No matches.'),
    glob: vi.fn().mockResolvedValue([]),
    initialize: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    working_directory: () => '/project',
    platform: () => 'linux',
    os_version: () => 'Linux 6.0',
    ...overrides,
  } satisfies ExecutionEnvironment;
}

describe('createGeminiProfile', () => {
  it('creates profile with default model', () => {
    const profile = createGeminiProfile();
    expect(profile.id).toBe('gemini');
    expect(profile.model).toBe('gemini-3-flash-preview');
  });

  it('creates profile with custom model', () => {
    const profile = createGeminiProfile('gemini-2.0-pro');
    expect(profile.model).toBe('gemini-2.0-pro');
  });

  it('allows overrides', () => {
    const profile = createGeminiProfile('gemini-3-flash-preview', {
      supports_reasoning: false,
    });
    expect(profile.supports_reasoning).toBe(false);
  });

  it('registers standard tools', () => {
    const profile = createGeminiProfile();
    const toolNames = profile.tools().map(t => t.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('read_many_files');
    expect(toolNames).toContain('write_file');
    expect(toolNames).toContain('edit_file');
    expect(toolNames).toContain('shell');
    expect(toolNames).toContain('grep');
    expect(toolNames).toContain('glob');
    expect(toolNames).toContain('list_dir');
    expect(toolNames).toContain('web_search');
    expect(toolNames).toContain('web_fetch');
  });

  it('registers subagent tool definitions', () => {
    const profile = createGeminiProfile();
    const toolNames = profile.tools().map(t => t.name);
    expect(toolNames).toContain('spawn_agent');
    expect(toolNames).toContain('send_input');
    expect(toolNames).toContain('wait');
    expect(toolNames).toContain('close_agent');
  });

  it('subagent tool executors throw not-wired-up error', async () => {
    const profile = createGeminiProfile();
    const spawnTool = profile.tool_registry.get('spawn_agent');
    expect(spawnTool).toBeDefined();
    await expect(
      spawnTool!.executor({}, makeEnv()),
    ).rejects.toThrow('not wired up');
  });

  it('supports_parallel_tool_calls is true', () => {
    const profile = createGeminiProfile();
    expect(profile.supports_parallel_tool_calls).toBe(true);
  });

  it('context_window_size is 1M+', () => {
    const profile = createGeminiProfile();
    expect(profile.context_window_size).toBe(1_048_576);
  });

  it('builds system prompt with environment context', () => {
    const profile = createGeminiProfile();
    const env = makeEnv();
    const prompt = profile.build_system_prompt(env, '');
    expect(prompt).toContain('coding assistant');
    expect(prompt).toContain('/project');
    expect(prompt).toContain('linux');
    expect(prompt).toContain('read_many_files');
    expect(prompt).toContain('web_search');
  });

  it('includes project docs in system prompt', () => {
    const profile = createGeminiProfile();
    const env = makeEnv();
    const prompt = profile.build_system_prompt(env, 'Use ESLint.');
    expect(prompt).toContain('Use ESLint.');
    expect(prompt).toContain('project-instructions');
  });

  it('omits project-instructions when projectDocs is empty', () => {
    const profile = createGeminiProfile();
    const env = makeEnv();
    const prompt = profile.build_system_prompt(env, '');
    expect(prompt).not.toContain('project-instructions');
  });

  it('provider_options returns gemini safety settings', () => {
    const profile = createGeminiProfile();
    const opts = profile.provider_options();
    expect(opts).toBeDefined();
    expect((opts as Record<string, unknown>).gemini).toBeDefined();
    const geminiOpts = (opts as Record<string, Record<string, unknown>>).gemini;
    expect(geminiOpts.safety_settings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gemini-specific tools
// ---------------------------------------------------------------------------

describe('Gemini-specific tools', () => {
  describe('read_many_files', () => {
    it('reads multiple files and returns formatted content', async () => {
      const profile = createGeminiProfile();
      const env = makeEnv({
        read_file: vi.fn()
          .mockResolvedValueOnce('content of file1')
          .mockResolvedValueOnce('content of file2'),
      });

      const tool = profile.tool_registry.get('read_many_files');
      expect(tool).toBeDefined();

      const result = await tool!.executor(
        { file_paths: ['/a.ts', '/b.ts'] },
        env,
      );

      expect(result).toContain('=== /a.ts ===');
      expect(result).toContain('content of file1');
      expect(result).toContain('=== /b.ts ===');
      expect(result).toContain('content of file2');
    });

    it('handles read errors gracefully', async () => {
      const profile = createGeminiProfile();
      const env = makeEnv({
        read_file: vi.fn().mockRejectedValue(new Error('ENOENT')),
      });

      const tool = profile.tool_registry.get('read_many_files');
      const result = await tool!.executor(
        { file_paths: ['/missing.ts'] },
        env,
      );

      expect(result).toContain('[Error: ENOENT]');
    });

    it('handles non-Error thrown values via String()', async () => {
      const profile = createGeminiProfile();
      const env = makeEnv({
        read_file: vi.fn().mockRejectedValue('string rejection'),
      });

      const tool = profile.tool_registry.get('read_many_files');
      const result = await tool!.executor(
        { file_paths: ['/broken.ts'] },
        env,
      );

      expect(result).toContain('[Error: string rejection]');
    });
  });

  describe('list_dir', () => {
    it('lists directory contents', async () => {
      const profile = createGeminiProfile();
      const env = makeEnv();

      const tool = profile.tool_registry.get('list_dir');
      expect(tool).toBeDefined();

      const result = await tool!.executor({ path: '/project' }, env);
      expect(result).toContain('file.ts');
      expect(result).toContain('100 bytes');
      expect(result).toContain('subdir/');
    });

    it('returns message for empty directory', async () => {
      const profile = createGeminiProfile();
      const env = makeEnv({
        list_directory: vi.fn().mockResolvedValue([]),
      });

      const tool = profile.tool_registry.get('list_dir');
      const result = await tool!.executor({ path: '/empty' }, env);
      expect(result).toBe('Directory is empty.');
    });

    it('uses default depth of 1', async () => {
      const profile = createGeminiProfile();
      const env = makeEnv();

      const tool = profile.tool_registry.get('list_dir');
      await tool!.executor({ path: '/project' }, env);

      expect(env.list_directory).toHaveBeenCalledWith('/project', 1);
    });

    it('respects custom depth', async () => {
      const profile = createGeminiProfile();
      const env = makeEnv();

      const tool = profile.tool_registry.get('list_dir');
      await tool!.executor({ path: '/project', depth: 3 }, env);

      expect(env.list_directory).toHaveBeenCalledWith('/project', 3);
    });
  });

  describe('web_search', () => {
    it('returns placeholder message', async () => {
      const profile = createGeminiProfile();
      const env = makeEnv();

      const tool = profile.tool_registry.get('web_search');
      expect(tool).toBeDefined();

      const result = await tool!.executor({ query: 'TypeScript tutorials' }, env);
      expect(result).toContain('Web search not implemented');
      expect(result).toContain('TypeScript tutorials');
    });
  });

  describe('web_fetch', () => {
    it('has correct definition', () => {
      const profile = createGeminiProfile();
      const tool = profile.tool_registry.get('web_fetch');
      expect(tool).toBeDefined();
      expect(tool!.definition.name).toBe('web_fetch');
    });

    it('fetches URL and returns truncated text', async () => {
      const mockText = 'Hello from the web!';
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => mockText,
      }) as unknown as typeof fetch;

      const profile = createGeminiProfile();
      const env = makeEnv();
      const tool = profile.tool_registry.get('web_fetch');
      const result = await tool!.executor({ url: 'https://example.com' }, env);
      expect(result).toBe('Hello from the web!');

      globalThis.fetch = originalFetch;
    });

    it('throws on non-ok response', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      }) as unknown as typeof fetch;

      const profile = createGeminiProfile();
      const env = makeEnv();
      const tool = profile.tool_registry.get('web_fetch');
      await expect(
        tool!.executor({ url: 'https://example.com/missing' }, env),
      ).rejects.toThrow('Failed to fetch URL (404)');

      globalThis.fetch = originalFetch;
    });

    it('truncates response to 50000 characters', async () => {
      const longText = 'x'.repeat(60000);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => longText,
      }) as unknown as typeof fetch;

      const profile = createGeminiProfile();
      const env = makeEnv();
      const tool = profile.tool_registry.get('web_fetch');
      const result = await tool!.executor({ url: 'https://example.com/big' }, env);
      expect(result.length).toBe(50000);

      globalThis.fetch = originalFetch;
    });
  });
});
