// ============================================================================
// High-Level API — generate(), stream(), generate_object()
// ============================================================================

import {
  Message,
  Role,
  ContentKind,
  StreamEventType,
  Usage,
  NoObjectGeneratedError,
  ConfigurationError,
  AbortError,
  RequestTimeoutError,
  Response as LLMResponse,
} from "./types.js";
import type {
  Request,
  Tool,
  ToolCall,
  ToolResult,
  ToolChoice,
  ResponseFormat,
  StepResult,
  GenerateResult,
  StreamEvent,
  StopCondition,
  TimeoutConfig,
  ToolDefinition,
} from "./types.js";
import { Client, getDefaultClient } from "./client.js";
import { retry } from "./utils/retry.js";

// --- generate() --------------------------------------------------------------

export interface GenerateOptions {
  model: string;
  prompt?: string;
  messages?: Message[];
  system?: string;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  max_tool_rounds?: number;
  stop_when?: StopCondition;
  response_format?: ResponseFormat;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop_sequences?: string[];
  reasoning_effort?: "none" | "low" | "medium" | "high";
  provider?: string;
  provider_options?: Record<string, Record<string, unknown>>;
  max_retries?: number;
  timeout?: number | TimeoutConfig;
  abort_signal?: AbortSignal;
  client?: Client;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const {
    model,
    prompt,
    messages: msgInput,
    system,
    tools = [],
    tool_choice,
    max_tool_rounds = 1,
    stop_when,
    response_format,
    temperature,
    top_p,
    max_tokens,
    stop_sequences,
    reasoning_effort,
    provider,
    provider_options,
    max_retries = 2,
    timeout,
    client: clientOverride,
  } = opts;
  let { abort_signal } = opts;

  if (prompt != null && msgInput != null) {
    throw new ConfigurationError("Provide either 'prompt' or 'messages', not both.");
  }

  // Wire up timeout as an abort signal
  const totalTimeout = typeof timeout === "number" ? timeout : timeout?.total;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (totalTimeout && !abort_signal) {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), totalTimeout);
    abort_signal = controller.signal;
  }

  const client = clientOverride ?? getDefaultClient();

  // Build initial messages
  const conversation: Message[] = [];
  if (system) {
    conversation.push(Message.system(system));
  }
  if (msgInput) {
    conversation.push(...msgInput);
  } else if (prompt != null) {
    conversation.push(Message.user(prompt));
  }

  // Build tool definitions (without execute handlers)
  const toolDefs: ToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  // Track active tools (those with execute handlers)
  const activeTools = new Map<string, Tool>();
  for (const tool of tools) {
    if (tool.execute) {
      activeTools.set(tool.name, tool);
    }
  }

  const steps: StepResult[] = [];
  let totalUsage = Usage.zero();

  for (let round = 0; round <= max_tool_rounds; round++) {
    // Build request
    const request: Request = {
      model,
      messages: [...conversation],
      provider,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      tool_choice,
      response_format,
      temperature,
      top_p,
      max_tokens,
      stop_sequences,
      reasoning_effort,
      provider_options,
    };

    // Check abort signal before each round
    if (abort_signal?.aborted) {
      if (timeoutId) clearTimeout(timeoutId);
      throw totalTimeout
        ? new RequestTimeoutError(`Request timed out after ${totalTimeout}ms`)
        : new AbortError();
    }

    // Execute with retry, racing against abort signal
    const completeCall = retry(
      () => client.complete(request),
      { max_retries },
    );
    const response = abort_signal
      ? await Promise.race([
          completeCall,
          new Promise<never>((_resolve, reject) => {
            if (abort_signal!.aborted) {
              reject(totalTimeout
                ? new RequestTimeoutError(`Request timed out after ${totalTimeout}ms`)
                : new AbortError());
              return;
            }
            abort_signal!.addEventListener("abort", () => {
              reject(totalTimeout
                ? new RequestTimeoutError(`Request timed out after ${totalTimeout}ms`)
                : new AbortError());
            }, { once: true });
          }),
        ])
      : await completeCall;

    const toolCalls = response.tool_calls;

    // Execute active tools if model requests them
    let toolResults: ToolResult[] = [];
    if (
      toolCalls.length > 0 &&
      response.finish_reason.reason === "tool_calls" &&
      activeTools.size > 0
    ) {
      toolResults = await executeAllTools(activeTools, toolCalls);
    }

    const step: StepResult = {
      text: response.text,
      reasoning: response.reasoning,
      tool_calls: toolCalls,
      tool_results: toolResults,
      finish_reason: response.finish_reason,
      usage: response.usage,
      response,
      warnings: response.warnings,
    };
    steps.push(step);
    totalUsage = totalUsage.add(response.usage);

    // Check stop conditions
    if (toolCalls.length === 0 || response.finish_reason.reason !== "tool_calls") {
      break; // Model is done
    }
    if (round >= max_tool_rounds) {
      break; // Budget exhausted
    }
    if (stop_when && stop_when(steps)) {
      break; // Custom stop condition
    }

    // If there are no active tools matching the calls, break (passive tools)
    if (toolResults.length === 0) {
      break;
    }

    // Continue conversation with tool results
    conversation.push(response.message);
    for (const result of toolResults) {
      conversation.push(
        Message.tool_result(
          result.tool_call_id,
          typeof result.content === "string" ? result.content : result.content as Record<string, unknown>,
          result.is_error,
        ),
      );
    }
  }

  if (timeoutId) clearTimeout(timeoutId);

  const finalStep = steps[steps.length - 1];
  return {
    text: finalStep.text,
    reasoning: finalStep.reasoning,
    tool_calls: finalStep.tool_calls,
    tool_results: finalStep.tool_results,
    finish_reason: finalStep.finish_reason,
    usage: finalStep.usage,
    total_usage: totalUsage,
    steps,
    response: finalStep.response,
  };
}

// --- stream() ----------------------------------------------------------------

export interface StreamOptions extends GenerateOptions {}

export interface StreamResult {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
  response(): Promise<LLMResponse>;
  textStream(): AsyncIterable<string>;
}

export function stream(opts: StreamOptions): StreamResult {
  const {
    model,
    prompt,
    messages: msgInput,
    system,
    tools = [],
    tool_choice,
    max_tool_rounds = 1,
    stop_when,
    response_format,
    temperature,
    top_p,
    max_tokens,
    stop_sequences,
    reasoning_effort,
    provider,
    provider_options,
    abort_signal,
    client: clientOverride,
  } = opts;

  if (prompt != null && msgInput != null) {
    throw new ConfigurationError("Provide either 'prompt' or 'messages', not both.");
  }

  const client = clientOverride ?? getDefaultClient();

  // Build initial messages
  const conversation: Message[] = [];
  if (system) {
    conversation.push(Message.system(system));
  }
  if (msgInput) {
    conversation.push(...msgInput);
  } else if (prompt != null) {
    conversation.push(Message.user(prompt));
  }

  const toolDefs: ToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const activeTools = new Map<string, Tool>();
  for (const tool of tools) {
    if (tool.execute) {
      activeTools.set(tool.name, tool);
    }
  }

  let resolvedResponse: LLMResponse | undefined;
  let resolveResponsePromise: ((r: LLMResponse) => void) | undefined;
  let rejectResponsePromise: ((err: Error) => void) | undefined;
  const responsePromise = new Promise<LLMResponse>((resolve, reject) => {
    resolveResponsePromise = resolve;
    rejectResponsePromise = reject;
  });

  async function* generateEvents(): AsyncGenerator<StreamEvent> {
    try {
      const steps: StepResult[] = [];

      for (let round = 0; round <= max_tool_rounds; round++) {
        const request: Request = {
          model,
          messages: [...conversation],
          provider,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          tool_choice,
          response_format,
          temperature,
          top_p,
          max_tokens,
          stop_sequences,
          reasoning_effort,
          provider_options,
        };

        let lastResponse: LLMResponse | undefined;

        for await (const event of client.stream(request)) {
          yield event;

          if (event.type === StreamEventType.FINISH && event.response) {
            lastResponse = event.response;
          }
        }

        if (!lastResponse) break;

        const toolCalls = lastResponse.tool_calls;
        let toolResults: ToolResult[] = [];

        if (
          toolCalls.length > 0 &&
          lastResponse.finish_reason.reason === "tool_calls" &&
          activeTools.size > 0
        ) {
          toolResults = await executeAllTools(activeTools, toolCalls);
        }

        steps.push({
          text: lastResponse.text,
          reasoning: lastResponse.reasoning,
          tool_calls: toolCalls,
          tool_results: toolResults,
          finish_reason: lastResponse.finish_reason,
          usage: lastResponse.usage,
          response: lastResponse,
          warnings: lastResponse.warnings,
        });

        resolvedResponse = lastResponse;

        // Check stop conditions
        if (toolCalls.length === 0 || lastResponse.finish_reason.reason !== "tool_calls") break;
        if (round >= max_tool_rounds) break;
        if (stop_when && stop_when(steps)) break;
        if (toolResults.length === 0) break;

        // Continue conversation
        conversation.push(lastResponse.message);
        for (const result of toolResults) {
          conversation.push(
            Message.tool_result(
              result.tool_call_id,
              typeof result.content === "string" ? result.content : result.content as Record<string, unknown>,
              result.is_error,
            ),
          );
        }

        // Emit step_finish event between rounds
        yield { type: "step_finish" as StreamEventType, raw: { round } };
      }

      if (resolvedResponse) {
        resolveResponsePromise?.(resolvedResponse);
      } else {
        rejectResponsePromise?.(new Error("Stream ended without producing a response"));
      }
    } catch (err) {
      rejectResponsePromise?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  // Buffer events so multiple consumers can independently iterate.
  const eventBuffer: StreamEvent[] = [];
  let sourceExhausted = false;
  let sourceError: Error | undefined;
  // All waiters are notified when new events arrive or source completes
  const waiters: Set<() => void> = new Set();

  function notifyAll() {
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  // Eagerly drain the source generator into the buffer
  (async () => {
    try {
      for await (const event of generateEvents()) {
        eventBuffer.push(event);
        notifyAll();
      }
    } catch (err) {
      sourceError = err instanceof Error ? err : new Error(String(err));
    } finally {
      sourceExhausted = true;
      notifyAll();
    }
  })();

  async function* createIterator(): AsyncGenerator<StreamEvent> {
    let index = 0;
    while (true) {
      if (index < eventBuffer.length) {
        yield eventBuffer[index++];
      } else if (sourceExhausted) {
        if (sourceError) throw sourceError;
        return;
      } else {
        await new Promise<void>((resolve) => {
          waiters.add(resolve);
        });
      }
    }
  }

  return {
    [Symbol.asyncIterator]() {
      return createIterator();
    },
    response() {
      return responsePromise;
    },
    textStream() {
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of createIterator()) {
            if (event.type === StreamEventType.TEXT_DELTA && event.delta) {
              yield event.delta;
            }
          }
        },
      };
    },
  };
}

// --- generate_object() -------------------------------------------------------

export interface GenerateObjectOptions extends Omit<GenerateOptions, "response_format"> {
  schema: Record<string, unknown>;
  schema_name?: string;
  schema_description?: string;
}

export async function generate_object(opts: GenerateObjectOptions): Promise<GenerateResult> {
  const { schema, schema_name, schema_description, ...restOpts } = opts;

  // Determine provider to pick strategy
  const providerName = opts.provider ?? opts.client?.defaultProvider ?? "openai";

  if (providerName === "anthropic") {
    // Anthropic: use tool-based extraction
    const extractTool: Tool = {
      name: schema_name ?? "extract_data",
      description: schema_description ?? "Extract the structured data from the user's input.",
      parameters: schema,
    };

    // Build modified system prompt
    const systemPrompt =
      (opts.system ?? "") +
      "\n\nYou must call the tool to provide your structured answer. " +
      "Do not respond with plain text.";

    const result = await generate({
      ...restOpts,
      system: systemPrompt.trim(),
      tools: [extractTool],
      tool_choice: { mode: "required" },
      max_tool_rounds: 0, // Don't actually execute the tool
    });

    // Extract the tool call arguments as the output
    if (result.tool_calls.length > 0) {
      result.output = result.tool_calls[0].arguments;
      return result;
    }

    // Fallback: try to parse text as JSON
    try {
      result.output = JSON.parse(result.text);
      return result;
    } catch {
      throw new NoObjectGeneratedError(
        "Anthropic model did not produce valid structured output. " +
        "The model did not call the extraction tool.",
      );
    }
  } else {
    // OpenAI / Gemini: use native json_schema
    const result = await generate({
      ...restOpts,
      response_format: {
        type: "json_schema",
        json_schema: schema,
        strict: true,
      },
    });

    try {
      result.output = JSON.parse(result.text);
    } catch (err) {
      throw new NoObjectGeneratedError(
        `Failed to parse structured output: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined,
      );
    }

    return result;
  }
}

// --- Tool Execution Helpers --------------------------------------------------

async function executeAllTools(
  tools: Map<string, Tool>,
  toolCalls: ToolCall[],
): Promise<ToolResult[]> {
  // Execute all tool calls concurrently
  const promises = toolCalls.map(async (call): Promise<ToolResult> => {
    const tool = tools.get(call.name);
    if (!tool || !tool.execute) {
      return {
        tool_call_id: call.id,
        content: `Unknown tool: ${call.name}`,
        is_error: true,
      };
    }

    try {
      const result = await tool.execute(call.arguments);
      const content =
        typeof result === "string"
          ? result
          : result == null
            ? ""
            : JSON.stringify(result);
      return {
        tool_call_id: call.id,
        content,
        is_error: false,
      };
    } catch (err: unknown) {
      return {
        tool_call_id: call.id,
        content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }
  });

  // Wait for ALL to complete, preserving order
  return Promise.all(promises);
}
