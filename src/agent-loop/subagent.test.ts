import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubAgentManager } from './subagent.js';
import { Session } from './session.js';
import { SessionState, EventKind } from './types.js';
import type {
  ProviderProfile,
  ExecutionEnvironment,
} from './types.js';
import type { LLMClient, LLMResponse } from './loop.js';
import { ToolRegistry } from './tools/registry.js';

function makeMinimalProfile(): ProviderProfile {
  const registry = new ToolRegistry();
  return {
    id: 'test',
    model: 'test-model',
    tool_registry: registry,
    build_system_prompt: () => 'You are a test agent.',
    tools: () => [],
    provider_options: () => null,
    supports_reasoning: false,
    supports_streaming: false,
    supports_parallel_tool_calls: false,
    context_window_size: 100_000,
  };
}

function makeMinimalEnv(): ExecutionEnvironment {
  return {
    read_file: vi.fn().mockResolvedValue(''),
    write_file: vi.fn().mockResolvedValue(undefined),
    file_exists: vi.fn().mockResolvedValue(false),
    list_directory: vi.fn().mockResolvedValue([]),
    exec_command: vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exit_code: 0,
      timed_out: false,
      duration_ms: 0,
    }),
    grep: vi.fn().mockResolvedValue('No matches.'),
    glob: vi.fn().mockResolvedValue([]),
    initialize: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    working_directory: () => '/test',
    platform: () => 'linux',
    os_version: () => 'Linux 6.0',
  } satisfies ExecutionEnvironment;
}

function makeResponse(text: string): LLMResponse {
  return {
    id: 'resp-1',
    text,
    tool_calls: [],
    reasoning: null,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    finish_reason: { reason: 'stop' },
  };
}

describe('SubAgentManager', () => {
  it('spawn creates child session', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('child output')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const handle = await manager.spawn({ task: 'Do something' });

    expect(handle.id).toBeDefined();
    expect(handle.status).toBe('running');
    expect(handle.result).toBeNull();

    // Wait for the child to complete
    const result = await manager.wait(handle.id);
    expect(result.success).toBe(true);
    expect(parent.subagents.has(handle.id)).toBe(true);
  });

  it('emits SUBAGENT_SPAWN event', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('done')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const events: string[] = [];
    parent.event_emitter.on(EventKind.SUBAGENT_SPAWN, () =>
      events.push('spawn'),
    );

    const manager = new SubAgentManager(parent);
    await manager.spawn({ task: 'task' });
    expect(events).toContain('spawn');
  });

  it('depth limit: cannot spawn sub-sub-agents', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('done')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
      config: { max_subagent_depth: 1 },
    });

    // Depth 1 — at the limit
    const manager = new SubAgentManager(parent, 1);
    await expect(
      manager.spawn({ task: 'should fail' }),
    ).rejects.toThrow('Max subagent depth');
  });

  it('close_agent terminates child', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            // Simulate a slow LLM call
            setTimeout(
              () => resolve(makeResponse('slow result')),
              200,
            ),
          ),
      ),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const handle = await manager.spawn({ task: 'long running task' });

    const closeResult = await manager.close(handle.id);
    expect(closeResult).toContain('closed');

    // After close, the parent's subagents map should reflect completed status
    const subHandle = parent.subagents.get(handle.id);
    expect(subHandle?.status).toBe('completed');
  });

  it('wait returns result after completion', async () => {
    const client: LLMClient = {
      complete: vi
        .fn()
        .mockResolvedValue(makeResponse('child says hello')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const handle = await manager.spawn({ task: 'greet' });
    const result = await manager.wait(handle.id);

    expect(result.success).toBe(true);
    expect(result.output).toContain('child says hello');
    expect(result.turns_used).toBeGreaterThanOrEqual(1);
  });

  it('wait on nonexistent agent throws', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('done')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    await expect(manager.wait('nonexistent-id')).rejects.toThrow(
      'Subagent not found',
    );
  });

  it('close on nonexistent agent throws', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('done')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    await expect(manager.close('nonexistent-id')).rejects.toThrow(
      'Subagent not found',
    );
  });

  it('emits SUBAGENT_COMPLETE event on success', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('done')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const events: Record<string, unknown>[] = [];
    parent.event_emitter.on(EventKind.SUBAGENT_COMPLETE, (e) =>
      events.push(e.data),
    );

    const manager = new SubAgentManager(parent);
    const handle = await manager.spawn({ task: 'complete me' });
    await manager.wait(handle.id);

    expect(events.length).toBe(1);
    expect((events[0] as { result: { success: boolean } }).result.success).toBe(true);
  });

  it('failed child session: LLM error leads to completed with empty output', async () => {
    // When the LLM rejects, Session.submit() catches the error internally
    // and transitions to CLOSED state. The promise does NOT reject, so
    // SubAgentManager's .then() handler fires (not .catch()).
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('LLM crash')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const handle = await manager.spawn({ task: 'will fail' });
    const result = await manager.wait(handle.id);

    // submit() swallows the error, so the subagent appears "completed" (success=true)
    // but with empty output since no assistant turn was recorded
    expect(result.success).toBe(true);
    expect(result.output).toBe('');
    expect(parent.subagents.get(handle.id)?.status).toBe('completed');
  });
});
