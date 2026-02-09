import { describe, it, expect, vi } from 'vitest';
import {
  processInput,
  convertHistoryToMessages,
  detectLoop,
} from './loop.js';
import type { LLMClient, LLMResponse, LoopContext } from './loop.js';
import { EventEmitter } from './events.js';
import {
  EventKind,
  SessionState,
  DEFAULT_SESSION_CONFIG,
} from './types.js';
import type {
  ProviderProfile,
  ExecutionEnvironment,
  Turn,
  AssistantTurn,
} from './types.js';
import { ToolRegistry } from './tools/registry.js';
import { Usage } from '../unified-llm/types.js';

function makeUsage(): { input_tokens: number; output_tokens: number; total_tokens: number } {
  return { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
}

function makeResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    id: 'resp-1',
    text: overrides.text ?? 'Done.',
    tool_calls: overrides.tool_calls ?? [],
    reasoning: overrides.reasoning ?? null,
    usage: overrides.usage ?? makeUsage(),
    finish_reason: overrides.finish_reason ?? { reason: 'stop' },
  };
}

function makeToolRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  // Register a simple read_file tool for testing
  reg.register({
    definition: {
      name: 'read_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
    },
    executor: async (args) => `content of ${args.file_path}`,
  });
  return reg;
}

function makeContext(overrides?: {
  client?: LLMClient;
  config?: Partial<typeof DEFAULT_SESSION_CONFIG>;
  registry?: ToolRegistry;
}): LoopContext {
  const registry = overrides?.registry ?? makeToolRegistry();
  return {
    id: 'test-session',
    provider_profile: {
      id: 'test',
      model: 'test-model',
      tool_registry: registry,
      build_system_prompt: () => 'You are a test agent.',
      tools: () => registry.definitions(),
      provider_options: () => null,
      supports_reasoning: false,
      supports_streaming: false,
      supports_parallel_tool_calls: false,
      context_window_size: 200_000,
    },
    execution_env: {
      read_file: vi.fn().mockResolvedValue('file content'),
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
    } satisfies ExecutionEnvironment,
    history: [],
    event_emitter: new EventEmitter('test-session'),
    config: {
      ...DEFAULT_SESSION_CONFIG,
      tool_output_limits: new Map(),
      tool_line_limits: new Map(),
      ...(overrides?.config ?? {}),
    },
    state: SessionState.IDLE,
    llm_client: overrides?.client ?? {
      complete: vi.fn().mockResolvedValue(makeResponse()),
    },
    steering_queue: [],
    followup_queue: [],
    abort_signaled: false,
  };
}

describe('processInput', () => {
  it('natural completion: LLM returns text with no tool calls -> loop exits', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue(
        makeResponse({ text: 'Hello! I can help.', tool_calls: [] }),
      ),
    };
    const ctx = makeContext({ client });

    await processInput(ctx, 'hi');

    expect(ctx.state).toBe(SessionState.IDLE);
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(ctx.history.some((t) => t.kind === 'user')).toBe(true);
    expect(ctx.history.some((t) => t.kind === 'assistant')).toBe(true);
  });

  it('tool execution: LLM returns tool call -> tool executed -> result sent back', async () => {
    const client: LLMClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({
            text: '',
            tool_calls: [
              { id: 't1', name: 'read_file', arguments: { file_path: '/x' } },
            ],
            finish_reason: { reason: 'tool_calls' },
          }),
        )
        .mockResolvedValueOnce(
          makeResponse({
            text: 'Here is the file content.',
            tool_calls: [],
          }),
        ),
    };
    const ctx = makeContext({ client });

    await processInput(ctx, 'read /x');

    expect(client.complete).toHaveBeenCalledTimes(2);
    // Should have: user, assistant (with tool call), tool_results, assistant (final)
    expect(ctx.history.filter((t) => t.kind === 'assistant')).toHaveLength(2);
    expect(ctx.history.filter((t) => t.kind === 'tool_results')).toHaveLength(1);

    const toolResults = ctx.history.find((t) => t.kind === 'tool_results');
    if (toolResults?.kind === 'tool_results') {
      expect(toolResults.results[0].tool_call_id).toBe('t1');
      expect(toolResults.results[0].is_error).toBe(false);
    }
  });

  it('round limit: stops after max_tool_rounds_per_input', async () => {
    let callCount = 0;
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        return makeResponse({
          text: '',
          tool_calls: [
            {
              id: `t${callCount}`,
              name: 'read_file',
              arguments: { file_path: `/file${callCount}` },
            },
          ],
          finish_reason: { reason: 'tool_calls' },
        });
      }),
    };
    const ctx = makeContext({
      client,
      config: { max_tool_rounds_per_input: 3 },
    });

    const events: string[] = [];
    ctx.event_emitter.on(EventKind.TURN_LIMIT, () => events.push('limit'));

    await processInput(ctx, 'do stuff');

    // roundCount increments after each tool execution, limit is checked before LLM call
    // So: LLM call 0 (round 0), tool exec -> round=1, LLM call 1 (round 1), tool exec -> round=2
    // LLM call 2 (round 2), tool exec -> round=3, then check: 3 >= 3, break
    expect(events).toContain('limit');
    // The client should have been called limited times (round limit hit at 3)
    expect(callCount).toBeLessThanOrEqual(4);
  });

  it('unknown tool returns error result', async () => {
    const client: LLMClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({
            text: '',
            tool_calls: [
              { id: 't1', name: 'nonexistent_tool', arguments: {} },
            ],
            finish_reason: { reason: 'tool_calls' },
          }),
        )
        .mockResolvedValueOnce(
          makeResponse({ text: 'OK understood.', tool_calls: [] }),
        ),
    };
    const ctx = makeContext({ client });

    await processInput(ctx, 'do something');

    const toolResults = ctx.history.find((t) => t.kind === 'tool_results');
    if (toolResults?.kind === 'tool_results') {
      expect(toolResults.results[0].is_error).toBe(true);
      expect(toolResults.results[0].content).toContain('Unknown tool');
    }
  });

  it('LLM error transitions to CLOSED', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('API key invalid')),
    };
    const ctx = makeContext({ client });
    const errorEvents: string[] = [];
    ctx.event_emitter.on(EventKind.ERROR, (e) =>
      errorEvents.push(e.data.error as string),
    );

    await processInput(ctx, 'hello');

    expect(ctx.state).toBe(SessionState.CLOSED);
    expect(errorEvents.length).toBeGreaterThan(0);
    expect(errorEvents[0]).toContain('API key invalid');
  });

  it('steering: injected message appears between rounds', async () => {
    const client: LLMClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({
            text: '',
            tool_calls: [
              { id: 't1', name: 'read_file', arguments: { file_path: '/x' } },
            ],
            finish_reason: { reason: 'tool_calls' },
          }),
        )
        .mockResolvedValueOnce(
          makeResponse({ text: 'Got it.', tool_calls: [] }),
        ),
    };
    const ctx = makeContext({ client });
    // Add steering message before submission
    ctx.steering_queue.push('Focus on TypeScript files only');

    await processInput(ctx, 'read files');

    // Steering turn should appear in history
    const steeringTurns = ctx.history.filter((t) => t.kind === 'steering');
    expect(steeringTurns.length).toBeGreaterThanOrEqual(1);
    expect(steeringTurns[0].kind === 'steering' && steeringTurns[0].content).toBe(
      'Focus on TypeScript files only',
    );
  });

  it('abort_signaled stops the loop', async () => {
    let callCount = 0;
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // After first call, signal abort
          return makeResponse({
            text: '',
            tool_calls: [
              { id: 't1', name: 'read_file', arguments: { file_path: '/x' } },
            ],
            finish_reason: { reason: 'tool_calls' },
          });
        }
        return makeResponse({ text: 'done', tool_calls: [] });
      }),
    };
    const ctx = makeContext({ client });
    // Signal abort after first tool round
    ctx.event_emitter.on(EventKind.TOOL_CALL_END, () => {
      ctx.abort_signaled = true;
    });

    await processInput(ctx, 'do work');
    // Should have stopped early
    expect(callCount).toBe(1);
  });

  it('follow-up queue is processed after main input', async () => {
    let callCount = 0;
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        return makeResponse({
          text: `Response ${callCount}`,
          tool_calls: [],
        });
      }),
    };
    const ctx = makeContext({ client });
    ctx.followup_queue.push('follow-up question');

    await processInput(ctx, 'first question');

    // Should have processed both the main input and the follow-up
    expect(callCount).toBe(2);
    const userTurns = ctx.history.filter((t) => t.kind === 'user');
    expect(userTurns).toHaveLength(2);
  });
});

describe('detectLoop', () => {
  function makeAssistantTurn(
    toolCalls: { name: string; args: Record<string, unknown> }[],
  ): AssistantTurn {
    return {
      kind: 'assistant',
      content: '',
      tool_calls: toolCalls.map((tc, i) => ({
        id: `t${i}`,
        name: tc.name,
        arguments: tc.args,
      })),
      reasoning: null,
      usage: makeUsage(),
      response_id: null,
      timestamp: new Date(),
    };
  }

  it('detects repeating single tool call pattern', () => {
    const history: Turn[] = [];
    // 6 identical tool calls
    for (let i = 0; i < 6; i++) {
      history.push(
        makeAssistantTurn([{ name: 'read_file', args: { file_path: '/x' } }]),
      );
    }
    expect(detectLoop(history, 6)).toBe(true);
  });

  it('detects repeating pattern of length 2', () => {
    const history: Turn[] = [];
    // A, B, A, B, A, B pattern
    for (let i = 0; i < 3; i++) {
      history.push(
        makeAssistantTurn([{ name: 'read_file', args: { file_path: '/a' } }]),
      );
      history.push(
        makeAssistantTurn([{ name: 'read_file', args: { file_path: '/b' } }]),
      );
    }
    expect(detectLoop(history, 6)).toBe(true);
  });

  it('no loop with varied tool calls', () => {
    const history: Turn[] = [];
    for (let i = 0; i < 6; i++) {
      history.push(
        makeAssistantTurn([
          { name: 'read_file', args: { file_path: `/file${i}` } },
        ]),
      );
    }
    expect(detectLoop(history, 6)).toBe(false);
  });

  it('returns false when not enough history', () => {
    const history: Turn[] = [
      makeAssistantTurn([{ name: 'read_file', args: { file_path: '/x' } }]),
    ];
    expect(detectLoop(history, 6)).toBe(false);
  });
});

describe('convertHistoryToMessages', () => {
  it('converts user turns to user messages', () => {
    const history: Turn[] = [
      { kind: 'user', content: 'hello', timestamp: new Date() },
    ];
    const messages = convertHistoryToMessages(history);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].text).toBe('hello');
  });

  it('converts assistant turns to assistant messages', () => {
    const history: Turn[] = [
      {
        kind: 'assistant',
        content: 'hi there',
        tool_calls: [],
        reasoning: null,
        usage: makeUsage(),
        response_id: null,
        timestamp: new Date(),
      },
    ];
    const messages = convertHistoryToMessages(history);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
  });

  it('converts tool_results turns to tool messages', () => {
    const history: Turn[] = [
      {
        kind: 'tool_results',
        results: [
          { tool_call_id: 't1', content: 'output', is_error: false },
        ],
        timestamp: new Date(),
      },
    ];
    const messages = convertHistoryToMessages(history);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('tool');
  });

  it('converts steering turns to user messages', () => {
    const history: Turn[] = [
      { kind: 'steering', content: 'be concise', timestamp: new Date() },
    ];
    const messages = convertHistoryToMessages(history);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].text).toBe('be concise');
  });

  it('converts system turns to system messages', () => {
    const history: Turn[] = [
      { kind: 'system', content: 'system prompt', timestamp: new Date() },
    ];
    const messages = convertHistoryToMessages(history);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
  });
});
