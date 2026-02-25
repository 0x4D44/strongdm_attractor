import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubAgentManager, createSubagentTools } from './subagent.js';
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

  it('sendInput throws on nonexistent agent', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('done')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    await expect(
      manager.sendInput('nonexistent-id', 'hello'),
    ).rejects.toThrow('Subagent not found');
  });

  it('sendInput throws on non-running agent', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('done')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const handle = await manager.spawn({ task: 'fast task' });

    // Wait for it to complete
    await manager.wait(handle.id);

    // Now try to send input to a completed agent
    await expect(
      manager.sendInput(handle.id, 'late message'),
    ).rejects.toThrow('not running');
  });

  it('spawn with optional model override', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('done')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const handle = await manager.spawn({
      task: 'do stuff',
      model: 'custom-model',
      max_turns: 5,
    });

    expect(handle.id).toBeDefined();
    expect(handle.status).toBe('running');

    // Wait for completion
    const result = await manager.wait(handle.id);
    expect(result.success).toBe(true);
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

  it('spawn error path: submit rejection triggers catch handler', async () => {
    // To trigger the .catch() path in spawn(), we need the Session constructor
    // to work but submit() to throw (not just have the LLM fail).
    // We do this by making the child session's submit throw synchronously
    // by mocking Session to make processInput throw a non-caught error.
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(() => {
        // Throw a non-Error to test the String() fallback in catch
        throw 'raw string error';
      }),
    };

    // The processInput error is caught by Session.submit(), so to get
    // the .catch() handler, we need processInput itself to reject
    // unhandled. But Session.submit() has try/catch. So the .catch()
    // path is only hit if Session.submit() itself rejects.
    // Let's verify that with a CLOSED session.
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: {
        complete: vi.fn().mockResolvedValue(makeResponse('ok')),
      },
    });

    // Close parent so child session's submit will work, but the child
    // session needs to fail. We make the child's LLM client fail in
    // a way that submit() doesn't catch: submit() catches errors, so
    // the .catch() only fires if the promise itself rejects.

    // Actually, the simplest way: override Session prototype to make submit throw
    const origSubmit = Session.prototype.submit;
    Session.prototype.submit = vi.fn().mockRejectedValue(new Error('submit exploded'));

    const manager = new SubAgentManager(parent);
    const handle = await manager.spawn({ task: 'test error path' });

    // Wait for the background promise to settle
    const result = await manager.wait(handle.id);

    expect(result.success).toBe(false);
    expect(result.output).toContain('submit exploded');
    expect(parent.subagents.get(handle.id)?.status).toBe('failed');

    // Restore
    Session.prototype.submit = origSubmit;
  });

  it('spawn error path emits SUBAGENT_COMPLETE on failure', async () => {
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: {
        complete: vi.fn().mockResolvedValue(makeResponse('ok')),
      },
    });

    const events: Record<string, unknown>[] = [];
    parent.event_emitter.on(EventKind.SUBAGENT_COMPLETE, (e) =>
      events.push(e.data),
    );

    const origSubmit = Session.prototype.submit;
    Session.prototype.submit = vi.fn().mockRejectedValue(new Error('kaboom'));

    const manager = new SubAgentManager(parent);
    const handle = await manager.spawn({ task: 'fail task' });
    await manager.wait(handle.id);

    expect(events.length).toBe(1);
    expect((events[0] as { result: { success: boolean } }).result.success).toBe(false);

    Session.prototype.submit = origSubmit;
  });

  it('spawn error path handles non-Error rejection', async () => {
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: {
        complete: vi.fn().mockResolvedValue(makeResponse('ok')),
      },
    });

    const origSubmit = Session.prototype.submit;
    Session.prototype.submit = vi.fn().mockRejectedValue('string rejection');

    const manager = new SubAgentManager(parent);
    const handle = await manager.spawn({ task: 'non-error fail' });
    const result = await manager.wait(handle.id);

    expect(result.success).toBe(false);
    expect(result.output).toBe('string rejection');

    Session.prototype.submit = origSubmit;
  });

  it('wait returns fallback result when no promise and no result', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('ok')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const handle = await manager.spawn({ task: 'test task' });

    // Access private _agents map and clear promise + result to exercise fallback
    const agents = (manager as unknown as { _agents: Map<string, { promise?: Promise<void>; result: unknown }> })._agents;
    const agent = agents.get(handle.id)!;
    // Wait for the actual promise first so it doesn't run in background
    if (agent.promise) await agent.promise;
    // Now clear both to simulate the edge case
    delete agent.promise;
    agent.result = null;

    const result = await manager.wait(handle.id);
    expect(result.output).toBe('');
    expect(result.success).toBe(false);
    expect(result.turns_used).toBe(0);
  });

  it('sendInput on running agent succeeds', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
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
    const handle = await manager.spawn({ task: 'long task' });

    const msg = await manager.sendInput(handle.id, 'extra info');
    expect(msg).toContain('Message sent');

    // Clean up
    await manager.close(handle.id);
  });
});

// ---------------------------------------------------------------------------
// createSubagentTools tests
// ---------------------------------------------------------------------------

describe('createSubagentTools', () => {
  it('returns 4 tools with correct names', () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('done')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const tools = createSubagentTools(manager);

    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.definition.name);
    expect(names).toContain('spawn_agent');
    expect(names).toContain('send_input');
    expect(names).toContain('wait');
    expect(names).toContain('close_agent');
  });

  it('spawn_agent executor spawns and returns agent id', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('child output')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const tools = createSubagentTools(manager);
    const spawnTool = tools.find((t) => t.definition.name === 'spawn_agent')!;

    const result = await spawnTool.executor(
      { task: 'do work' },
      makeMinimalEnv(),
    );
    const parsed = JSON.parse(result);
    expect(parsed.agent_id).toBeDefined();
    expect(parsed.status).toBe('running');

    // Clean up: wait for subagent
    const waitTool = tools.find((t) => t.definition.name === 'wait')!;
    await waitTool.executor({ agent_id: parsed.agent_id }, makeMinimalEnv());
  });

  it('spawn_agent executor passes optional args', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('done')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const tools = createSubagentTools(manager);
    const spawnTool = tools.find((t) => t.definition.name === 'spawn_agent')!;

    const result = await spawnTool.executor(
      {
        task: 'custom task',
        working_dir: '/custom',
        model: 'custom-model',
        max_turns: 10,
      },
      makeMinimalEnv(),
    );
    const parsed = JSON.parse(result);
    expect(parsed.agent_id).toBeDefined();

    // Clean up
    const waitTool = tools.find((t) => t.definition.name === 'wait')!;
    await waitTool.executor({ agent_id: parsed.agent_id }, makeMinimalEnv());
  });

  it('send_input executor sends message to subagent', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(makeResponse('slow')), 200),
          ),
      ),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const tools = createSubagentTools(manager);
    const spawnTool = tools.find((t) => t.definition.name === 'spawn_agent')!;
    const sendInputTool = tools.find((t) => t.definition.name === 'send_input')!;
    const closeTool = tools.find((t) => t.definition.name === 'close_agent')!;

    const spawnResult = JSON.parse(
      await spawnTool.executor({ task: 'run' }, makeMinimalEnv()),
    );

    const sendResult = await sendInputTool.executor(
      { agent_id: spawnResult.agent_id, message: 'more info' },
      makeMinimalEnv(),
    );
    expect(sendResult).toContain('Message sent');

    // Clean up
    await closeTool.executor({ agent_id: spawnResult.agent_id }, makeMinimalEnv());
  });

  it('wait executor waits for completion and returns result', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(makeResponse('final answer')),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const tools = createSubagentTools(manager);
    const spawnTool = tools.find((t) => t.definition.name === 'spawn_agent')!;
    const waitTool = tools.find((t) => t.definition.name === 'wait')!;

    const spawnResult = JSON.parse(
      await spawnTool.executor({ task: 'answer question' }, makeMinimalEnv()),
    );

    const waitResult = await waitTool.executor(
      { agent_id: spawnResult.agent_id },
      makeMinimalEnv(),
    );
    const parsed = JSON.parse(waitResult);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toContain('final answer');
    expect(parsed.turns_used).toBeGreaterThanOrEqual(1);
  });

  it('close_agent executor terminates subagent', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(makeResponse('slow')), 200),
          ),
      ),
    };
    const parent = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const manager = new SubAgentManager(parent);
    const tools = createSubagentTools(manager);
    const spawnTool = tools.find((t) => t.definition.name === 'spawn_agent')!;
    const closeTool = tools.find((t) => t.definition.name === 'close_agent')!;

    const spawnResult = JSON.parse(
      await spawnTool.executor({ task: 'run forever' }, makeMinimalEnv()),
    );

    const closeResult = await closeTool.executor(
      { agent_id: spawnResult.agent_id },
      makeMinimalEnv(),
    );
    expect(closeResult).toContain('closed');
  });
});
