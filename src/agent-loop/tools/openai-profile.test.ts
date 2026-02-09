import { describe, it, expect, vi } from 'vitest';
import { createOpenAIProfile, applyPatchTool } from './openai-profile.js';
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

// ---------------------------------------------------------------------------
// Profile creation
// ---------------------------------------------------------------------------

describe('createOpenAIProfile', () => {
  it('creates profile with default model', () => {
    const profile = createOpenAIProfile();
    expect(profile.id).toBe('openai');
    expect(profile.model).toBe('gpt-5.2-codex');
    expect(profile.supports_reasoning).toBe(true);
    expect(profile.supports_streaming).toBe(true);
    expect(profile.supports_parallel_tool_calls).toBe(true);
  });

  it('creates profile with custom model', () => {
    const profile = createOpenAIProfile('gpt-4');
    expect(profile.model).toBe('gpt-4');
  });

  it('allows overrides', () => {
    const profile = createOpenAIProfile('gpt-4', {
      supports_reasoning: false,
      context_window_size: 50_000,
    });
    expect(profile.supports_reasoning).toBe(false);
    expect(profile.context_window_size).toBe(50_000);
  });

  it('registers standard tools', () => {
    const profile = createOpenAIProfile();
    const toolNames = profile.tools().map(t => t.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('apply_patch');
    expect(toolNames).toContain('write_file');
    expect(toolNames).toContain('shell');
    expect(toolNames).toContain('grep');
    expect(toolNames).toContain('glob');
  });

  it('registers subagent tool definitions', () => {
    const profile = createOpenAIProfile();
    const toolNames = profile.tools().map(t => t.name);
    expect(toolNames).toContain('spawn_agent');
    expect(toolNames).toContain('send_input');
    expect(toolNames).toContain('wait');
    expect(toolNames).toContain('close_agent');
  });

  it('subagent tool executors throw not-wired-up error', async () => {
    const profile = createOpenAIProfile();
    const spawnTool = profile.tool_registry.get('spawn_agent');
    expect(spawnTool).toBeDefined();
    await expect(
      spawnTool!.executor({}, makeEnv()),
    ).rejects.toThrow('not wired up');
  });

  it('builds system prompt with environment context', () => {
    const profile = createOpenAIProfile();
    const env = makeEnv();
    const prompt = profile.build_system_prompt(env, '');
    expect(prompt).toContain('coding agent');
    expect(prompt).toContain('/project');
    expect(prompt).toContain('linux');
  });

  it('includes project docs in system prompt', () => {
    const profile = createOpenAIProfile();
    const env = makeEnv();
    const prompt = profile.build_system_prompt(env, 'Use TypeScript.');
    expect(prompt).toContain('Use TypeScript.');
    expect(prompt).toContain('project-instructions');
  });

  it('provider_options returns null', () => {
    const profile = createOpenAIProfile();
    expect(profile.provider_options()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// apply_patch tool
// ---------------------------------------------------------------------------

describe('applyPatchTool', () => {
  it('has correct definition', () => {
    expect(applyPatchTool.definition.name).toBe('apply_patch');
  });

  it('creates a new file', async () => {
    const env = makeEnv();
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+export const x = 1;
+export const y = 2;
*** End Patch`;

    const result = await applyPatchTool.executor({ patch }, env);
    expect(result).toContain('Created src/new.ts');
    expect(env.write_file).toHaveBeenCalledWith(
      'src/new.ts',
      'export const x = 1;\nexport const y = 2;',
    );
  });

  it('deletes a file', async () => {
    const env = makeEnv();
    // Mock to make unlinkSync work (we need to handle the fs call)
    const patch = `*** Begin Patch
*** Delete File: src/old.ts
*** End Patch`;

    // This will call unlinkSync on the resolved path
    // The test may fail on unlinkSync, but we handle ENOENT
    const result = await applyPatchTool.executor({ patch }, env);
    expect(result).toContain('Deleted src/old.ts');
  });

  it('updates a file with hunk', async () => {
    const env = makeEnv({
      read_file: vi.fn().mockResolvedValue('line1\nline2\nline3\n'),
    });

    const patch = `*** Begin Patch
*** Update File: src/file.ts
@@ line2
 line2
-line3
+line3_modified
*** End Patch`;

    const result = await applyPatchTool.executor({ patch }, env);
    expect(result).toContain('Updated src/file.ts');
    expect(env.write_file).toHaveBeenCalledWith(
      'src/file.ts',
      expect.stringContaining('line3_modified'),
    );
  });

  it('returns "No operations performed." for empty patch', async () => {
    const env = makeEnv();
    const patch = `*** Begin Patch
*** End Patch`;

    const result = await applyPatchTool.executor({ patch }, env);
    expect(result).toBe('No operations performed.');
  });

  it('throws when hunk context cannot be found', async () => {
    const env = makeEnv({
      read_file: vi.fn().mockResolvedValue('different content\nno match\n'),
    });

    const patch = `*** Begin Patch
*** Update File: src/file.ts
@@ nonexistent context
 this line does not exist
-remove this
+add this
*** End Patch`;

    await expect(
      applyPatchTool.executor({ patch }, env),
    ).rejects.toThrow('Could not find matching context');
  });

  it('handles move_to in update operations', async () => {
    const env = makeEnv({
      read_file: vi.fn().mockResolvedValue('content\n'),
    });

    const patch = `*** Begin Patch
*** Update File: src/old-name.ts
*** Move to: src/new-name.ts
@@ content
 content
*** End Patch`;

    const result = await applyPatchTool.executor({ patch }, env);
    expect(result).toContain('moved');
    expect(result).toContain('src/new-name.ts');
    expect(env.write_file).toHaveBeenCalledWith(
      'src/new-name.ts',
      expect.any(String),
    );
  });

  it('fuzzy matches lines with different whitespace', async () => {
    const env = makeEnv({
      read_file: vi.fn().mockResolvedValue('  line1  \n  line2  \n  line3  \n'),
    });

    const patch = `*** Begin Patch
*** Update File: src/file.ts
@@ line2
 line2
-line3
+line3_new
*** End Patch`;

    // Fuzzy match should handle the whitespace differences
    const result = await applyPatchTool.executor({ patch }, env);
    expect(result).toContain('Updated src/file.ts');
  });
});
