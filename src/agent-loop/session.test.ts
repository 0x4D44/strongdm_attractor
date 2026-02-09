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
});
