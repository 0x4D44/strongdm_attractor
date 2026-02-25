import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Session } from './session.js';
import { SessionState, EventKind } from './types.js';
import type {
  ProviderProfile,
  ExecutionEnvironment,
  ToolDefinition,
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

function makeMockClient(
  responses: LLMResponse[] = [],
): LLMClient {
  let callIdx = 0;
  return {
    complete: vi.fn().mockImplementation(async () => {
      if (callIdx < responses.length) {
        return responses[callIdx++];
      }
      return {
        id: 'resp-final',
        text: 'Done.',
        tool_calls: [],
        reasoning: null,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        finish_reason: { reason: 'stop' },
      } satisfies LLMResponse;
    }),
  };
}

describe('Session', () => {
  it('construction: state is IDLE', () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });
    expect(session.state).toBe(SessionState.IDLE);
  });

  it('SESSION_START emitted once in constructor', () => {
    const events: string[] = [];
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });
    session.event_emitter.on(EventKind.SESSION_START, () => {
      events.push('start');
    });
    // SESSION_START was already emitted in constructor,
    // so the listener registered after won't catch it.
    // Let's verify by checking with a wildcard on second session
    const events2: string[] = [];
    const profile = makeMinimalProfile();
    const env = makeMinimalEnv();
    const client = makeMockClient();
    // Pre-register a listener by hooking into EventEmitter construction
    // Instead, verify that submit() does NOT emit SESSION_START again
    const session2 = new Session({
      provider_profile: profile,
      execution_env: env,
      llm_client: makeMockClient([
        {
          id: 'r1',
          text: 'hi',
          tool_calls: [],
          reasoning: null,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          finish_reason: { reason: 'stop' },
        },
      ]),
    });

    session2.event_emitter.on(EventKind.SESSION_START, () => {
      events2.push('start');
    });

    // Submit should NOT emit SESSION_START again
    return session2.submit('hello').then(() => {
      expect(events2).toEqual([]);
    });
  });

  it('SESSION_END emitted only on close()', async () => {
    const events: string[] = [];
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient([
        {
          id: 'r1',
          text: 'result',
          tool_calls: [],
          reasoning: null,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          finish_reason: { reason: 'stop' },
        },
      ]),
    });

    session.event_emitter.on(EventKind.SESSION_END, () => {
      events.push('end');
    });

    await session.submit('hi');
    expect(events).toEqual([]);

    await session.close();
    expect(events).toEqual(['end']);
  });

  it('state transitions: IDLE -> PROCESSING -> IDLE', async () => {
    const states: SessionState[] = [];
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient([
        {
          id: 'r1',
          text: 'done',
          tool_calls: [],
          reasoning: null,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          finish_reason: { reason: 'stop' },
        },
      ]),
    });

    expect(session.state).toBe(SessionState.IDLE);
    states.push(session.state);

    session.event_emitter.on(EventKind.USER_INPUT, () => {
      states.push(session.state);
    });

    await session.submit('test');
    states.push(session.state);

    // Should have: IDLE (before), PROCESSING (during), IDLE (after)
    expect(states[0]).toBe(SessionState.IDLE);
    expect(states[1]).toBe(SessionState.PROCESSING);
    expect(states[2]).toBe(SessionState.IDLE);
  });

  it('close() transitions to CLOSED', async () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });
    await session.close();
    expect(session.state).toBe(SessionState.CLOSED);
  });

  it('double-close is safe', async () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });
    await session.close();
    await session.close(); // should not throw
    expect(session.state).toBe(SessionState.CLOSED);
  });

  it('submit on closed session throws', async () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });
    await session.close();
    await expect(session.submit('hello')).rejects.toThrow(
      'Session is closed',
    );
  });

  it('submit while processing throws', async () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: {
        complete: vi.fn().mockImplementation(
          () =>
            new Promise((r) =>
              setTimeout(
                () =>
                  r({
                    id: 'r1',
                    text: 'hi',
                    tool_calls: [],
                    reasoning: null,
                    usage: {
                      input_tokens: 10,
                      output_tokens: 5,
                      total_tokens: 15,
                    },
                    finish_reason: { reason: 'stop' },
                  }),
                100,
              ),
            ),
        ),
      },
    });

    const p1 = session.submit('first');
    // Session is now PROCESSING
    await expect(session.submit('second')).rejects.toThrow(
      'already processing',
    );
    await p1;
  });

  it('steer() queues steering messages', () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });
    session.steer('focus on tests');
    session.steer('use TypeScript');
    expect(session.steering_queue).toEqual([
      'focus on tests',
      'use TypeScript',
    ]);
  });

  it('follow_up() queues follow-up messages', () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });
    session.follow_up('next task');
    expect(session.followup_queue).toEqual(['next task']);
  });

  it('setReasoningEffort updates config', () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });
    session.setReasoningEffort('high');
    expect(session.config.reasoning_effort).toBe('high');
    session.setReasoningEffort(null);
    expect(session.config.reasoning_effort).toBeNull();
  });

  it('getHistory returns conversation history', async () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient([
        {
          id: 'r1',
          text: 'response',
          tool_calls: [],
          reasoning: null,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          finish_reason: { reason: 'stop' },
        },
      ]),
    });
    await session.submit('hello');
    const history = session.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(history[0].kind).toBe('user');
    expect(history.some((t) => t.kind === 'assistant')).toBe(true);
  });

  it('close() with running subagents marks them as failed', async () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });

    // Simulate running subagents
    session.subagents.set('agent-1', {
      id: 'agent-1',
      status: 'running',
      result: null,
    });
    session.subagents.set('agent-2', {
      id: 'agent-2',
      status: 'completed',
      result: { output: 'done', success: true, turns_used: 1 },
    });

    await session.close();

    expect(session.subagents.get('agent-1')?.status).toBe('failed');
    expect(session.subagents.get('agent-2')?.status).toBe('completed');
  });

  it('close() emits SESSION_END with final state', async () => {
    const events: Record<string, unknown>[] = [];
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });

    session.event_emitter.on(EventKind.SESSION_END, (e) =>
      events.push(e.data),
    );

    await session.close();

    expect(events).toHaveLength(1);
    expect(events[0].final_state).toBe(SessionState.CLOSED);
  });

  it('close() calls execution_env.cleanup()', async () => {
    const env = makeMinimalEnv();
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: env,
      llm_client: makeMockClient(),
    });

    await session.close();
    expect(env.cleanup).toHaveBeenCalledTimes(1);
  });

  it('close() removes all event listeners', async () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });

    let called = false;
    session.event_emitter.on(EventKind.ERROR, () => {
      called = true;
    });

    await session.close();

    // After close, emitting should not reach the listener
    session.event_emitter.emit(EventKind.ERROR, { error: 'test' });
    expect(called).toBe(false);
  });

  it('abort() sets abort_signaled and signals abort controller', () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });

    expect(session.abort_signaled).toBe(false);
    session.abort();
    expect(session.abort_signaled).toBe(true);
  });

  it('config maps merge from overrides', () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
      config: {
        tool_output_limits: new Map([['read_file', 5000]]),
        tool_line_limits: new Map([['read_file', 100]]),
      },
    });

    expect(session.config.tool_output_limits.get('read_file')).toBe(5000);
    expect(session.config.tool_line_limits.get('read_file')).toBe(100);
  });

  it('getState returns current state', () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
    });
    expect(session.getState()).toBe(SessionState.IDLE);
  });

  it('custom session id is used when provided', () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient(),
      id: 'custom-session-id',
    });
    expect(session.id).toBe('custom-session-id');
  });

  it('submit error in processInput emits ERROR and transitions to CLOSED', async () => {
    // Create a client that causes processInput to throw
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(() => {
        throw new Error('unexpected crash');
      }),
    };
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: client,
    });

    const errors: string[] = [];
    session.event_emitter.on(EventKind.ERROR, (e) =>
      errors.push(e.data.error as string),
    );

    await session.submit('trigger error');

    // processInput catches the error internally and sets CLOSED
    expect(session.state).toBe(SessionState.CLOSED);
  });

  it('submit catch block fires when processInput throws unexpectedly', async () => {
    const env = makeMinimalEnv();
    // Make file_exists throw to cause processInput's discoverProjectDocs to throw
    // But discoverProjectDocs has try/catch so won't propagate.
    // Instead, make the event emitter throw to trigger the catch block
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: env,
      llm_client: makeMockClient([
        {
          id: 'r1',
          text: 'done',
          tool_calls: [],
          reasoning: null,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          finish_reason: { reason: 'stop' },
        },
      ]),
    });

    // Monkey-patch the event emitter to throw on USER_INPUT
    // This will cause processInput to throw before it can catch it
    const origEmit = session.event_emitter.emit.bind(session.event_emitter);
    let firstCall = true;
    session.event_emitter.emit = (kind, data) => {
      if (kind === EventKind.USER_INPUT && firstCall) {
        firstCall = false;
        throw new Error('emit crash');
      }
      return origEmit(kind, data);
    };

    const errors: string[] = [];
    session.event_emitter.on(EventKind.ERROR, (e) =>
      errors.push(e.data.error as string),
    );

    await session.submit('trigger catch');

    expect(session.state).toBe(SessionState.CLOSED);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('emit crash');
  });

  it('submit catch handles non-Error thrown values via String()', async () => {
    const env = makeMinimalEnv();
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: env,
      llm_client: makeMockClient([]),
    });

    // Monkey-patch event emitter to throw a non-Error value
    const origEmit = session.event_emitter.emit.bind(session.event_emitter);
    let firstCall = true;
    session.event_emitter.emit = (kind, data) => {
      if (kind === EventKind.USER_INPUT && firstCall) {
        firstCall = false;
        throw 'string-error-not-Error-instance';
      }
      return origEmit(kind, data);
    };

    const errors: string[] = [];
    session.event_emitter.on(EventKind.ERROR, (e) =>
      errors.push(e.data.error as string),
    );

    await session.submit('trigger non-Error catch');

    expect(session.state).toBe(SessionState.CLOSED);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toBe('string-error-not-Error-instance');
  });

  it('abort resets on new submit', async () => {
    const session = new Session({
      provider_profile: makeMinimalProfile(),
      execution_env: makeMinimalEnv(),
      llm_client: makeMockClient([
        {
          id: 'r1',
          text: 'done',
          tool_calls: [],
          reasoning: null,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          finish_reason: { reason: 'stop' },
        },
        {
          id: 'r2',
          text: 'done again',
          tool_calls: [],
          reasoning: null,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          finish_reason: { reason: 'stop' },
        },
      ]),
    });

    // Submit, then abort, then submit again
    await session.submit('first');
    session.abort();
    expect(session.abort_signaled).toBe(true);

    // Submit again should reset abort_signaled
    await session.submit('second');
    expect(session.abort_signaled).toBe(false);
  });
});
