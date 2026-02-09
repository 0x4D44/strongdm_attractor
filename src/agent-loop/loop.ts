/**
 * Core agentic loop — the centerpiece of the coding agent.
 *
 * process_input(): LLM call -> tool execution -> loop until natural completion.
 * Uses Client.complete() from unified-llm (NOT generate()).
 * Implements steering, loop detection, truncation, parallel tool execution.
 */

import { createHash } from 'node:crypto';
import type {
  Turn,
  UserTurn,
  AssistantTurn,
  ToolResultsTurn,
  SteeringTurn,
  ToolCall,
  ToolResult,
  SessionConfig,
  ProviderProfile,
  ExecutionEnvironment,
  Usage,
} from './types.js';
import { EventKind, SessionState } from './types.js';
import { Message, ContentKind, Role } from '../unified-llm/types.js';
import type { ContentPart } from '../unified-llm/types.js';
import type { EventEmitter } from './events.js';
import { truncateToolOutput } from './truncation.js';

/**
 * Minimal interface for the LLM client — only needs complete().
 * This avoids importing the full unified-llm Client.
 */
export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export interface LLMRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinitionLLM[];
  tool_choice?: string;
  reasoning_effort?: string | null;
  provider?: string;
  provider_options?: Record<string, unknown> | null;
}

export interface ToolDefinitionLLM {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  id: string;
  text: string;
  tool_calls: ToolCall[];
  reasoning: string | null;
  usage: Usage;
  finish_reason: { reason: string };
}

/**
 * Session-like context passed to the loop.
 * The Session class implements this interface.
 */
export interface LoopContext {
  id: string;
  provider_profile: ProviderProfile;
  execution_env: ExecutionEnvironment;
  history: Turn[];
  event_emitter: EventEmitter;
  config: SessionConfig;
  state: SessionState;
  llm_client: LLMClient;
  steering_queue: string[];
  followup_queue: string[];
  abort_signaled: boolean;
}

// ---------------------------------------------------------------------------
// History conversion
// ---------------------------------------------------------------------------

/**
 * Convert internal Turn history to LLM Message array.
 */
export function convertHistoryToMessages(history: Turn[]): Message[] {
  const messages: Message[] = [];

  for (const turn of history) {
    switch (turn.kind) {
      case 'user':
        messages.push(Message.user(turn.content));
        break;
      case 'assistant': {
        const parts: ContentPart[] = [];
        if (turn.content) {
          parts.push({ kind: ContentKind.TEXT, text: turn.content });
        }
        if (turn.tool_calls) {
          for (const tc of turn.tool_calls) {
            parts.push({
              kind: ContentKind.TOOL_CALL,
              tool_call: {
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
              },
            });
          }
        }
        messages.push(
          new Message({ role: Role.ASSISTANT, content: parts }),
        );
        break;
      }
      case 'tool_results':
        for (const result of turn.results) {
          messages.push(
            Message.tool_result(
              result.tool_call_id,
              typeof result.content === 'string'
                ? result.content
                : JSON.stringify(result.content),
              result.is_error,
            ),
          );
        }
        break;
      case 'steering':
        messages.push(Message.user(turn.content));
        break;
      case 'system':
        messages.push(Message.system(turn.content));
        break;
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Project doc discovery
// ---------------------------------------------------------------------------

/**
 * Discover project instruction files (AGENTS.md, CLAUDE.md, etc.)
 */
export async function discoverProjectDocs(
  env: ExecutionEnvironment,
  profileId: string,
): Promise<string> {
  const workDir = env.working_directory();
  const parts: string[] = [];
  let totalBytes = 0;
  const MAX_BYTES = 32 * 1024; // 32KB budget

  // Universal files
  const universalFiles = ['AGENTS.md'];

  // Provider-specific files
  const providerFiles: Record<string, string[]> = {
    openai: ['.codex/instructions.md'],
    anthropic: ['CLAUDE.md'],
    gemini: ['GEMINI.md'],
  };

  const filesToLoad = [
    ...universalFiles,
    ...(providerFiles[profileId] ?? []),
  ];

  for (const fileName of filesToLoad) {
    try {
      const exists = await env.file_exists(
        `${workDir}/${fileName}`,
      );
      if (!exists) continue;
      const rawContent = await env.read_file(`${workDir}/${fileName}`);
      // Strip line numbers from read_file output
      const content = rawContent
        .split('\n')
        .map((line) => {
          const match = line.match(/^\s*\d+\s*\|\s?(.*)/);
          return match ? match[1] : line;
        })
        .join('\n');

      if (totalBytes + content.length > MAX_BYTES) {
        const remaining = MAX_BYTES - totalBytes;
        if (remaining > 0) {
          parts.push(content.slice(0, remaining));
          parts.push('[Project instructions truncated at 32KB]');
        }
        break;
      }
      parts.push(content);
      totalBytes += content.length;
    } catch {
      // File not readable, skip
    }
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

/**
 * Extract tool call signatures from recent history.
 */
function extractToolCallSignatures(
  history: Turn[],
  count: number,
): string[] {
  const signatures: string[] = [];

  for (let i = history.length - 1; i >= 0 && signatures.length < count; i--) {
    const turn = history[i];
    if (turn.kind === 'assistant' && turn.tool_calls) {
      for (
        let j = turn.tool_calls.length - 1;
        j >= 0 && signatures.length < count;
        j--
      ) {
        const tc = turn.tool_calls[j];
        const argsHash = createHash('md5')
          .update(JSON.stringify(tc.arguments))
          .digest('hex')
          .slice(0, 8);
        signatures.unshift(`${tc.name}:${argsHash}`);
      }
    }
  }

  return signatures;
}

/**
 * Detect repeating patterns in tool calls.
 */
export function detectLoop(history: Turn[], windowSize: number): boolean {
  const recent = extractToolCallSignatures(history, windowSize);
  if (recent.length < windowSize) return false;

  // Check for repeating patterns of length 1, 2, or 3
  for (const patternLen of [1, 2, 3]) {
    if (windowSize % patternLen !== 0) continue;
    const pattern = recent.slice(0, patternLen);
    let allMatch = true;
    for (let i = patternLen; i < windowSize; i += patternLen) {
      const chunk = recent.slice(i, i + patternLen);
      if (chunk.length !== pattern.length) {
        allMatch = false;
        break;
      }
      for (let j = 0; j < patternLen; j++) {
        if (chunk[j] !== pattern[j]) {
          allMatch = false;
          break;
        }
      }
      if (!allMatch) break;
    }
    if (allMatch) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Drain steering
// ---------------------------------------------------------------------------

function drainSteering(ctx: LoopContext): void {
  while (ctx.steering_queue.length > 0) {
    const msg = ctx.steering_queue.shift()!;
    const steeringTurn: SteeringTurn = {
      kind: 'steering',
      content: msg,
      timestamp: new Date(),
    };
    ctx.history.push(steeringTurn);
    ctx.event_emitter.emit(EventKind.STEERING_INJECTED, { content: msg });
  }
}

// ---------------------------------------------------------------------------
// Count turns
// ---------------------------------------------------------------------------

function countTurns(history: Turn[]): number {
  let count = 0;
  for (const turn of history) {
    if (turn.kind === 'user' || turn.kind === 'assistant') {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Context window check
// ---------------------------------------------------------------------------

function checkContextUsage(ctx: LoopContext): void {
  let totalChars = 0;
  for (const turn of ctx.history) {
    if ('content' in turn && typeof turn.content === 'string') {
      totalChars += turn.content.length;
    }
    if (turn.kind === 'tool_results') {
      for (const r of turn.results) {
        totalChars += typeof r.content === 'string' ? r.content.length : 100;
      }
    }
  }
  const approxTokens = totalChars / 4;
  const threshold = ctx.provider_profile.context_window_size * 0.8;
  if (approxTokens > threshold) {
    const pct = Math.round(
      (approxTokens / ctx.provider_profile.context_window_size) * 100,
    );
    ctx.event_emitter.emit(EventKind.WARNING, {
      message: `Context usage at ~${pct}% of context window`,
    });
  }
}

// ---------------------------------------------------------------------------
// Execute tool calls
// ---------------------------------------------------------------------------

async function executeSingleTool(
  ctx: LoopContext,
  toolCall: ToolCall,
): Promise<ToolResult> {
  ctx.event_emitter.emit(EventKind.TOOL_CALL_START, {
    tool_name: toolCall.name,
    call_id: toolCall.id,
  });

  const registered = ctx.provider_profile.tool_registry.get(toolCall.name);
  if (!registered) {
    const errorMsg = `Unknown tool: ${toolCall.name}`;
    ctx.event_emitter.emit(EventKind.TOOL_CALL_END, {
      call_id: toolCall.id,
      error: errorMsg,
    });
    return {
      tool_call_id: toolCall.id,
      content: errorMsg,
      is_error: true,
    };
  }

  try {
    const args =
      typeof toolCall.arguments === 'string'
        ? JSON.parse(toolCall.arguments)
        : toolCall.arguments;

    // Validate arguments before execution
    const validation = ctx.provider_profile.tool_registry.validate(toolCall.name, args);
    if (!validation.valid) {
      ctx.event_emitter.emit(EventKind.TOOL_CALL_END, {
        call_id: toolCall.id,
        error: `Validation error: ${validation.error}`,
      });
      return {
        tool_call_id: toolCall.id,
        content: `Validation error: ${validation.error}`,
        is_error: true,
      };
    }

    const rawOutput = await registered.executor(args, ctx.execution_env);

    // Truncate output before sending to LLM
    const truncatedOutput = truncateToolOutput(
      rawOutput,
      toolCall.name,
      ctx.config,
    );

    // Emit full output via event stream (not truncated)
    ctx.event_emitter.emit(EventKind.TOOL_CALL_END, {
      call_id: toolCall.id,
      output: rawOutput,
    });

    return {
      tool_call_id: toolCall.id,
      content: truncatedOutput,
      is_error: false,
    };
  } catch (err) {
    const errorMsg = `Tool error (${toolCall.name}): ${err instanceof Error ? err.message : String(err)}`;
    ctx.event_emitter.emit(EventKind.TOOL_CALL_END, {
      call_id: toolCall.id,
      error: errorMsg,
    });
    return {
      tool_call_id: toolCall.id,
      content: errorMsg,
      is_error: true,
    };
  }
}

async function executeToolCalls(
  ctx: LoopContext,
  toolCalls: ToolCall[],
): Promise<ToolResult[]> {
  if (
    ctx.provider_profile.supports_parallel_tool_calls &&
    toolCalls.length > 1
  ) {
    return Promise.all(
      toolCalls.map((tc) => executeSingleTool(ctx, tc)),
    );
  }

  const results: ToolResult[] = [];
  for (const tc of toolCalls) {
    results.push(await executeSingleTool(ctx, tc));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Core agentic loop
// ---------------------------------------------------------------------------

/**
 * Process user input through the agentic loop.
 * Loops: LLM call -> tool execution -> until natural completion or limit.
 */
export async function processInput(
  ctx: LoopContext,
  userInput: string,
): Promise<void> {
  ctx.state = SessionState.PROCESSING;

  const userTurn: UserTurn = {
    kind: 'user',
    content: userInput,
    timestamp: new Date(),
  };
  ctx.history.push(userTurn);
  ctx.event_emitter.emit(EventKind.USER_INPUT, { content: userInput });

  // Drain pending steering messages before the first LLM call
  drainSteering(ctx);

  // Discover project docs once per input (not every iteration)
  const projectDocs = await discoverProjectDocs(
    ctx.execution_env,
    ctx.provider_profile.id,
  );

  let roundCount = 0;

  while (true) {
    // 1. Check limits
    if (roundCount >= ctx.config.max_tool_rounds_per_input) {
      ctx.event_emitter.emit(EventKind.TURN_LIMIT, {
        round: roundCount,
      });
      break;
    }

    if (
      ctx.config.max_turns > 0 &&
      countTurns(ctx.history) >= ctx.config.max_turns
    ) {
      ctx.event_emitter.emit(EventKind.TURN_LIMIT, {
        total_turns: countTurns(ctx.history),
      });
      break;
    }

    if (ctx.abort_signaled) {
      break;
    }

    // 2. Build LLM request
    const systemPrompt = ctx.provider_profile.build_system_prompt(
      ctx.execution_env,
      projectDocs,
    );
    const messages = convertHistoryToMessages(ctx.history);
    const toolDefs = ctx.provider_profile.tools();

    const systemMessage = Message.system(systemPrompt);

    const request: LLMRequest = {
      model: ctx.provider_profile.model,
      messages: [systemMessage, ...messages],
      tools: toolDefs,
      tool_choice: 'auto',
      reasoning_effort: ctx.config.reasoning_effort,
      provider: ctx.provider_profile.id,
      provider_options: ctx.provider_profile.provider_options() ?? undefined,
    };

    // 3. Call LLM
    ctx.event_emitter.emit(EventKind.LLM_CALL_START, {
      model: ctx.provider_profile.model,
      round: roundCount,
    });

    let response: LLMResponse;
    try {
      response = await ctx.llm_client.complete(request);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      ctx.event_emitter.emit(EventKind.ERROR, { error: errorMsg });
      ctx.state = SessionState.CLOSED;
      return;
    }

    ctx.event_emitter.emit(EventKind.LLM_CALL_END, {
      model: ctx.provider_profile.model,
      usage: response.usage,
    });

    // 4. Record assistant turn
    const assistantTurn: AssistantTurn = {
      kind: 'assistant',
      content: response.text ?? '',
      tool_calls: response.tool_calls ?? [],
      reasoning: response.reasoning,
      usage: response.usage,
      response_id: response.id,
      timestamp: new Date(),
    };
    ctx.history.push(assistantTurn);

    ctx.event_emitter.emit(EventKind.ASSISTANT_TEXT_END, {
      text: response.text,
      reasoning: response.reasoning,
    });

    // 5. If no tool calls, natural completion
    if (!response.tool_calls || response.tool_calls.length === 0) {
      ctx.event_emitter.emit(EventKind.TURN_COMPLETE, {
        reason: 'natural',
        round: roundCount,
      });
      break;
    }

    // 6. Execute tool calls
    roundCount++;
    const results = await executeToolCalls(ctx, response.tool_calls);
    const toolResultsTurn: ToolResultsTurn = {
      kind: 'tool_results',
      results,
      timestamp: new Date(),
    };
    ctx.history.push(toolResultsTurn);

    // 7. Drain steering messages injected during tool execution
    drainSteering(ctx);

    // 8. Loop detection
    if (ctx.config.enable_loop_detection) {
      if (detectLoop(ctx.history, ctx.config.loop_detection_window)) {
        const warning =
          `Loop detected: the last ${ctx.config.loop_detection_window} ` +
          `tool calls follow a repeating pattern. Try a different approach.`;
        const warningTurn: SteeringTurn = {
          kind: 'steering',
          content: warning,
          timestamp: new Date(),
        };
        ctx.history.push(warningTurn);
        ctx.event_emitter.emit(EventKind.LOOP_DETECTION, {
          message: warning,
        });
      }
    }

    // Check context usage
    checkContextUsage(ctx);
  }

  // Process follow-up messages if any are queued
  if (ctx.followup_queue.length > 0) {
    const nextInput = ctx.followup_queue.shift()!;
    await processInput(ctx, nextInput);
    return;
  }

  ctx.state = SessionState.IDLE;
}
