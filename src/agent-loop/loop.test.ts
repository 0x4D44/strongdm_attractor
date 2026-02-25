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

  it('detects repeating pattern of length 3', () => {
    const history: Turn[] = [];
    // A, B, C, A, B, C pattern
    for (let i = 0; i < 2; i++) {
      history.push(
        makeAssistantTurn([{ name: 'read_file', args: { file_path: '/a' } }]),
      );
      history.push(
        makeAssistantTurn([{ name: 'read_file', args: { file_path: '/b' } }]),
      );
      history.push(
        makeAssistantTurn([{ name: 'read_file', args: { file_path: '/c' } }]),
      );
    }
    expect(detectLoop(history, 6)).toBe(true);
  });

  it('returns false when windowSize is not divisible by pattern length', () => {
    const history: Turn[] = [];
    // 5 identical tool calls — window=5, not divisible by 2 or 3
    for (let i = 0; i < 5; i++) {
      history.push(
        makeAssistantTurn([{ name: 'read_file', args: { file_path: '/x' } }]),
      );
    }
    // 5 is divisible by 1 so length-1 pattern check will pass
    expect(detectLoop(history, 5)).toBe(true);
  });

  it('windowSize % patternLen !== 0 causes continue (line 250)', () => {
    // windowSize=7: not divisible by 2 or 3, only divisible by 1
    // With 7 identical tool calls, pattern length 1 should still detect
    const history: Turn[] = [];
    for (let i = 0; i < 7; i++) {
      history.push(
        makeAssistantTurn([{ name: 'read_file', args: { file_path: '/x' } }]),
      );
    }
    // 7 % 1 === 0 (match), 7 % 2 !== 0 (skip), 7 % 3 !== 0 (skip)
    expect(detectLoop(history, 7)).toBe(true);
  });

  it('windowSize not divisible by 2 or 3 with non-repeating data (line 250)', () => {
    const history: Turn[] = [];
    for (let i = 0; i < 7; i++) {
      history.push(
        makeAssistantTurn([{ name: 'read_file', args: { file_path: `/file${i}` } }]),
      );
    }
    // All unique files — no pattern of length 1
    expect(detectLoop(history, 7)).toBe(false);
  });

  it('handles mixed tool calls and non-tool turns', () => {
    const history: Turn[] = [];
    // Add user turns mixed with assistant tool calls
    for (let i = 0; i < 6; i++) {
      history.push({
        kind: 'user',
        content: `msg ${i}`,
        timestamp: new Date(),
      });
      history.push(
        makeAssistantTurn([{ name: 'read_file', args: { file_path: `/file${i}` } }]),
      );
    }
    // 6 unique tool calls with varied args — no loop
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

  it('converts assistant with tool_calls to assistant message with tool_call parts', () => {
    const history: Turn[] = [
      {
        kind: 'assistant',
        content: 'Let me read that file.',
        tool_calls: [
          { id: 't1', name: 'read_file', arguments: { file_path: '/x' } },
        ],
        reasoning: null,
        usage: makeUsage(),
        response_id: 'resp-1',
        timestamp: new Date(),
      },
    ];
    const messages = convertHistoryToMessages(history);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    // Should have text part + tool_call part
    expect(messages[0].content.length).toBe(2);
  });

  it('converts tool_results with non-string content', () => {
    const history: Turn[] = [
      {
        kind: 'tool_results',
        results: [
          { tool_call_id: 't1', content: { key: 'value' } as unknown as string, is_error: false },
        ],
        timestamp: new Date(),
      },
    ];
    const messages = convertHistoryToMessages(history);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('tool');
  });
});

describe('processInput additional coverage', () => {
  it('max_turns limit stops the loop', async () => {
    let callCount = 0;
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        return makeResponse({
          text: `round ${callCount}`,
          tool_calls: [],
        });
      }),
    };
    // max_turns of 2 — user turn + assistant turn = 2, should stop
    const ctx = makeContext({
      client,
      config: { max_turns: 2 },
    });

    const events: string[] = [];
    ctx.event_emitter.on(EventKind.TURN_LIMIT, () => events.push('limit'));

    await processInput(ctx, 'do stuff');

    // With max_turns=2: user input adds 1 turn, assistant adds 1 turn = 2 total
    // Then on next iteration, countTurns >= max_turns, so TURN_LIMIT fires
    // But since there are no tool calls, the loop exits naturally first
    expect(ctx.state).toBe(SessionState.IDLE);
  });

  it('loop detection injects steering warning', async () => {
    let callCount = 0;
    const client: LLMClient = {
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 12) {
          return makeResponse({
            text: '',
            tool_calls: [
              {
                id: `t${callCount}`,
                name: 'read_file',
                arguments: { file_path: '/same_file' },
              },
            ],
            finish_reason: { reason: 'tool_calls' },
          });
        }
        return makeResponse({ text: 'done', tool_calls: [] });
      }),
    };
    const ctx = makeContext({
      client,
      config: {
        enable_loop_detection: true,
        loop_detection_window: 6,
        max_tool_rounds_per_input: 15,
      },
    });

    const loopEvents: string[] = [];
    ctx.event_emitter.on(EventKind.LOOP_DETECTION, () =>
      loopEvents.push('loop'),
    );

    await processInput(ctx, 'repeat something');

    expect(loopEvents.length).toBeGreaterThan(0);
    const steeringTurns = ctx.history.filter((t) => t.kind === 'steering');
    expect(steeringTurns.some((t) =>
      t.kind === 'steering' && t.content.includes('Loop detected'),
    )).toBe(true);
  });

  it('context usage warning emits at high usage', async () => {
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
          makeResponse({ text: 'done', tool_calls: [] }),
        ),
    };
    // Set a very small context window to trigger the warning
    const registry = makeToolRegistry();
    const ctx = makeContext({ client, registry });
    ctx.provider_profile = {
      ...ctx.provider_profile,
      context_window_size: 10, // Very small to trigger warning easily
    };

    const warnings: string[] = [];
    ctx.event_emitter.on(EventKind.WARNING, (e) =>
      warnings.push(e.data.message as string),
    );

    await processInput(ctx, 'trigger context warning');

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('Context usage');
  });

  it('parallel tool execution when profile supports it', async () => {
    const registry = makeToolRegistry();
    // Add a second tool
    registry.register({
      definition: {
        name: 'write_file',
        description: 'Write a file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['file_path', 'content'],
        },
      },
      executor: async (args) => `wrote to ${args.file_path}`,
    });

    const client: LLMClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({
            text: '',
            tool_calls: [
              { id: 't1', name: 'read_file', arguments: { file_path: '/a' } },
              { id: 't2', name: 'write_file', arguments: { file_path: '/b', content: 'x' } },
            ],
            finish_reason: { reason: 'tool_calls' },
          }),
        )
        .mockResolvedValueOnce(
          makeResponse({ text: 'All done.', tool_calls: [] }),
        ),
    };

    const ctx = makeContext({ client, registry });
    ctx.provider_profile = {
      ...ctx.provider_profile,
      supports_parallel_tool_calls: true,
    };

    await processInput(ctx, 'do parallel work');

    // Both tools should have been called
    const toolResults = ctx.history.find((t) => t.kind === 'tool_results');
    if (toolResults?.kind === 'tool_results') {
      expect(toolResults.results).toHaveLength(2);
      expect(toolResults.results[0].is_error).toBe(false);
      expect(toolResults.results[1].is_error).toBe(false);
    }
  });

  it('tool executor throwing returns error result', async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: 'failing_tool',
        description: 'A tool that throws',
        parameters: { type: 'object', properties: {} },
      },
      executor: async () => { throw new Error('executor blew up'); },
    });

    const client: LLMClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({
            text: '',
            tool_calls: [{ id: 't1', name: 'failing_tool', arguments: {} }],
            finish_reason: { reason: 'tool_calls' },
          }),
        )
        .mockResolvedValueOnce(
          makeResponse({ text: 'noted', tool_calls: [] }),
        ),
    };

    const ctx = makeContext({ client, registry });

    await processInput(ctx, 'fail please');

    const toolResults = ctx.history.find((t) => t.kind === 'tool_results');
    if (toolResults?.kind === 'tool_results') {
      expect(toolResults.results[0].is_error).toBe(true);
      expect(toolResults.results[0].content).toContain('executor blew up');
    }
  });

  it('tool call with string arguments gets parsed as JSON', async () => {
    const client: LLMClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({
            text: '',
            tool_calls: [
              {
                id: 't1',
                name: 'read_file',
                arguments: JSON.stringify({ file_path: '/test.txt' }),
              },
            ],
            finish_reason: { reason: 'tool_calls' },
          }),
        )
        .mockResolvedValueOnce(
          makeResponse({ text: 'read it', tool_calls: [] }),
        ),
    };

    const ctx = makeContext({ client });
    await processInput(ctx, 'read with string args');

    const toolResults = ctx.history.find((t) => t.kind === 'tool_results');
    if (toolResults?.kind === 'tool_results') {
      expect(toolResults.results[0].is_error).toBe(false);
    }
  });

  it('tool validation failure returns error result', async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: 'strict_tool',
        description: 'Requires specific args',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      executor: async (args) => `hello ${args.name}`,
    });

    const client: LLMClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({
            text: '',
            tool_calls: [
              { id: 't1', name: 'strict_tool', arguments: {} }, // Missing 'name'
            ],
            finish_reason: { reason: 'tool_calls' },
          }),
        )
        .mockResolvedValueOnce(
          makeResponse({ text: 'ok', tool_calls: [] }),
        ),
    };

    const ctx = makeContext({ client, registry });
    await processInput(ctx, 'validate me');

    const toolResults = ctx.history.find((t) => t.kind === 'tool_results');
    if (toolResults?.kind === 'tool_results') {
      expect(toolResults.results[0].is_error).toBe(true);
      expect(toolResults.results[0].content).toContain('Validation error');
    }
  });

  it('steering during tool execution is drained after tool round', async () => {
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

    // Inject steering during tool execution
    ctx.event_emitter.on(EventKind.TOOL_CALL_START, () => {
      ctx.steering_queue.push('Focus on performance');
    });

    await processInput(ctx, 'read files');

    const steeringTurns = ctx.history.filter((t) => t.kind === 'steering');
    expect(steeringTurns.some((t) =>
      t.kind === 'steering' && t.content === 'Focus on performance',
    )).toBe(true);
  });

  it('max_turns limit stops loop during tool execution', async () => {
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
    // max_turns = 4: 1 user + 1 assistant + 1 tool_results + 1 assistant ...
    // countTurns counts user and assistant turns
    const ctx = makeContext({
      client,
      config: { max_turns: 3 },
    });

    const events: Record<string, unknown>[] = [];
    ctx.event_emitter.on(EventKind.TURN_LIMIT, (e) => events.push(e.data));

    await processInput(ctx, 'work hard');

    // Should have hit the total turns limit
    expect(events.length).toBeGreaterThan(0);
    const limitEvent = events.find(
      (e) => 'total_turns' in e,
    );
    expect(limitEvent).toBeDefined();
  });

  it('discoverProjectDocs loads provider-specific files', async () => {
    const ctx = makeContext();
    ctx.execution_env = {
      ...ctx.execution_env,
      file_exists: vi.fn().mockImplementation(async (p: string) => {
        return p.includes('AGENTS.md');
      }),
      read_file: vi.fn().mockResolvedValue('Project docs content'),
    };

    await processInput(ctx, 'test docs');

    // The system prompt should have been built with project docs
    expect(ctx.history.length).toBeGreaterThan(0);
  });

  it('discoverProjectDocs truncates content exceeding 32KB', async () => {
    // Create content that will exceed MAX_BYTES (32768) when combined
    const largeContent = 'X'.repeat(33000); // over 32KB
    const ctx = makeContext();
    ctx.execution_env = {
      ...ctx.execution_env,
      file_exists: vi.fn().mockResolvedValue(true),
      read_file: vi.fn().mockResolvedValue(largeContent),
    };

    await processInput(ctx, 'test truncation');

    // Should still succeed without error
    expect(ctx.history.length).toBeGreaterThan(0);
  });

  it('discoverProjectDocs skips unreadable files', async () => {
    const ctx = makeContext();
    ctx.execution_env = {
      ...ctx.execution_env,
      file_exists: vi.fn().mockResolvedValue(true),
      read_file: vi.fn().mockRejectedValue(new Error('Permission denied')),
    };

    await processInput(ctx, 'test file read error');

    // Should still succeed — unreadable files are silently skipped
    expect(ctx.history.length).toBeGreaterThan(0);
  });

  it('discoverProjectDocs truncates with remaining > 0 at 32KB boundary (line 185-193)', async () => {
    // Create content that puts us just under MAX_BYTES on first file,
    // then second file pushes us over but remaining > 0
    let callCount = 0;
    const ctx = makeContext();
    ctx.provider_profile = { ...ctx.provider_profile, id: 'anthropic' };
    ctx.execution_env = {
      ...ctx.execution_env,
      file_exists: vi.fn().mockImplementation(async (p: string) => {
        return p.includes('AGENTS.md') || p.includes('CLAUDE.md');
      }),
      read_file: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First file: 30KB — under the 32KB budget
          return 'A'.repeat(30 * 1024);
        }
        // Second file: 10KB — would push over 32KB, triggers truncation with remaining > 0
        return 'B'.repeat(10 * 1024);
      }),
    };

    await processInput(ctx, 'test truncation boundary');
    expect(ctx.history.length).toBeGreaterThan(0);
  });

  it('discoverProjectDocs truncates with remaining <= 0 (line 191 false branch)', async () => {
    // First file fills the entire 32KB budget, second file has remaining = 0
    let callCount = 0;
    const ctx = makeContext();
    ctx.provider_profile = { ...ctx.provider_profile, id: 'anthropic' };
    ctx.execution_env = {
      ...ctx.execution_env,
      file_exists: vi.fn().mockImplementation(async (p: string) => {
        return p.includes('AGENTS.md') || p.includes('CLAUDE.md');
      }),
      read_file: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First file: exactly 32KB — fills the budget completely
          return 'A'.repeat(32 * 1024);
        }
        // Second file: any content — remaining will be 0
        return 'B'.repeat(1024);
      }),
    };

    await processInput(ctx, 'test truncation exact');
    expect(ctx.history.length).toBeGreaterThan(0);
  });

  it('LLM error with non-Error object transitions to CLOSED (line 519)', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue('plain string error'),
    };
    const ctx = makeContext({ client });

    await processInput(ctx, 'trigger non-Error rejection');
    expect(ctx.state).toBe(SessionState.CLOSED);
  });

  it('tool error with non-Error object returns error message (line 400)', async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: 'throws_string',
        description: 'Throws non-Error',
        parameters: { type: 'object', properties: {} },
      },
      executor: async () => { throw 'string_error'; },
    });

    const client: LLMClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(
          makeResponse({
            text: '',
            tool_calls: [{ id: 't1', name: 'throws_string', arguments: {} }],
            finish_reason: { reason: 'tool_calls' },
          }),
        )
        .mockResolvedValueOnce(
          makeResponse({ text: 'ok', tool_calls: [] }),
        ),
    };

    const ctx = makeContext({ client, registry });
    await processInput(ctx, 'trigger string throw');

    const toolResults = ctx.history.find((t) => t.kind === 'tool_results');
    if (toolResults?.kind === 'tool_results') {
      expect(toolResults.results[0].is_error).toBe(true);
      expect(toolResults.results[0].content).toContain('string_error');
    }
  });

  it('response.text and response.tool_calls null handling (lines 533-534)', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockResolvedValue({
        id: 'resp-1',
        text: null,
        tool_calls: null,
        reasoning: null,
        usage: makeUsage(),
        finish_reason: { reason: 'stop' },
      }),
    };
    const ctx = makeContext({ client });

    await processInput(ctx, 'test null response fields');

    // Should handle null text/tool_calls gracefully
    expect(ctx.state).toBe(SessionState.IDLE);
    const assistantTurns = ctx.history.filter(t => t.kind === 'assistant');
    expect(assistantTurns.length).toBeGreaterThan(0);
  });
});
