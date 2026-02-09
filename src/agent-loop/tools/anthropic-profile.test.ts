import { describe, it, expect, vi } from 'vitest';
import { createAnthropicProfile } from './anthropic-profile.js';
import type { ExecutionEnvironment } from '../types.js';

function makeEnv(overrides: Partial<ExecutionEnvironment> = {}): ExecutionEnvironment {
  return {
    read_file: vi.fn().mockResolvedValue(''),
    write_file: vi.fn().mockResolvedValue(undefined),
    file_exists: vi.fn().mockResolvedValue(false),
    list_directory: vi.fn().mockResolvedValue([]),
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

describe('createAnthropicProfile', () => {
  it('creates profile with default model', () => {
    const profile = createAnthropicProfile();
    expect(profile.id).toBe('anthropic');
    expect(profile.model).toBe('claude-opus-4-6');
  });

  it('creates profile with custom model', () => {
    const profile = createAnthropicProfile('claude-haiku-4-5-20251001');
    expect(profile.model).toBe('claude-haiku-4-5-20251001');
  });

  it('allows overrides', () => {
    const profile = createAnthropicProfile('claude-opus-4-6', {
      supports_streaming: false,
    });
    expect(profile.supports_streaming).toBe(false);
  });

  it('registers standard tools', () => {
    const profile = createAnthropicProfile();
    const toolNames = profile.tools().map(t => t.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('write_file');
    expect(toolNames).toContain('edit_file');
    expect(toolNames).toContain('shell');
    expect(toolNames).toContain('grep');
    expect(toolNames).toContain('glob');
  });

  it('does NOT include apply_patch (that is OpenAI-specific)', () => {
    const profile = createAnthropicProfile();
    const toolNames = profile.tools().map(t => t.name);
    expect(toolNames).not.toContain('apply_patch');
  });

  it('registers subagent tool definitions', () => {
    const profile = createAnthropicProfile();
    const toolNames = profile.tools().map(t => t.name);
    expect(toolNames).toContain('spawn_agent');
    expect(toolNames).toContain('send_input');
    expect(toolNames).toContain('wait');
    expect(toolNames).toContain('close_agent');
  });

  it('subagent tool executors throw not-wired-up error', async () => {
    const profile = createAnthropicProfile();
    const spawnTool = profile.tool_registry.get('spawn_agent');
    expect(spawnTool).toBeDefined();
    await expect(
      spawnTool!.executor({}, makeEnv()),
    ).rejects.toThrow('not wired up');
  });

  it('supports_parallel_tool_calls is false', () => {
    const profile = createAnthropicProfile();
    expect(profile.supports_parallel_tool_calls).toBe(false);
  });

  it('supports_reasoning is true', () => {
    const profile = createAnthropicProfile();
    expect(profile.supports_reasoning).toBe(true);
  });

  it('context_window_size is 200k', () => {
    const profile = createAnthropicProfile();
    expect(profile.context_window_size).toBe(200_000);
  });

  it('builds system prompt with environment context', () => {
    const profile = createAnthropicProfile();
    const env = makeEnv();
    const prompt = profile.build_system_prompt(env, '');
    expect(prompt).toContain('interactive agent');
    expect(prompt).toContain('/project');
    expect(prompt).toContain('linux');
    expect(prompt).toContain('edit_file');
  });

  it('includes project docs in system prompt', () => {
    const profile = createAnthropicProfile();
    const env = makeEnv();
    const prompt = profile.build_system_prompt(env, 'Use strict mode.');
    expect(prompt).toContain('Use strict mode.');
    expect(prompt).toContain('project-instructions');
  });

  it('omits project-instructions when projectDocs is empty', () => {
    const profile = createAnthropicProfile();
    const env = makeEnv();
    const prompt = profile.build_system_prompt(env, '');
    expect(prompt).not.toContain('project-instructions');
  });

  it('provider_options returns anthropic beta headers', () => {
    const profile = createAnthropicProfile();
    const opts = profile.provider_options();
    expect(opts).toBeDefined();
    expect((opts as Record<string, unknown>).anthropic).toBeDefined();
    const anthropicOpts = (opts as Record<string, Record<string, unknown>>).anthropic;
    expect(anthropicOpts.beta_headers).toContain('interleaved-thinking-2025-05-14');
    expect(anthropicOpts.beta_headers).toContain('token-efficient-tools-2025-02-19');
  });

  it('shell tool defaults timeout to 120s when not specified', async () => {
    const profile = createAnthropicProfile();
    const env = makeEnv();

    const shellRegistered = profile.tool_registry.get('shell');
    expect(shellRegistered).toBeDefined();

    // Execute shell with no timeout_ms
    await shellRegistered!.executor({ command: 'echo hi' }, env);

    // Should have called exec_command with 120_000 timeout
    expect(env.exec_command).toHaveBeenCalledWith('echo hi', 120_000);
  });

  it('shell tool defaults timeout to 120s when timeout_ms is 0', async () => {
    const profile = createAnthropicProfile();
    const env = makeEnv();

    const shellRegistered = profile.tool_registry.get('shell');
    await shellRegistered!.executor({ command: 'echo hi', timeout_ms: 0 }, env);

    expect(env.exec_command).toHaveBeenCalledWith('echo hi', 120_000);
  });

  it('shell tool uses specified timeout when provided', async () => {
    const profile = createAnthropicProfile();
    const env = makeEnv();

    const shellRegistered = profile.tool_registry.get('shell');
    await shellRegistered!.executor({ command: 'echo hi', timeout_ms: 5000 }, env);

    expect(env.exec_command).toHaveBeenCalledWith('echo hi', 5000);
  });
});
