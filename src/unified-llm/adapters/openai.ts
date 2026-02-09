// ============================================================================
// OpenAI Adapter — Responses API (/v1/responses)
// ============================================================================

import {
  ContentKind,
  Role,
  StreamEventType,
  Message,
  Usage,
  Response as LLMResponse,
} from "../types.js";
import type {
  ProviderAdapter,
  Request,
  StreamEvent,
  ToolDefinition,
  ToolChoice,
  FinishReason,
  ContentPart,
  RateLimitInfo,
} from "../types.js";
import { httpRequest, httpStreamRequest, raiseForStatus, parseRateLimitHeaders } from "../utils/http.js";
import { parseSSEStream } from "../utils/sse.js";

export interface OpenAIAdapterOptions {
  api_key: string;
  base_url?: string;
  default_headers?: Record<string, string>;
  timeout?: number;
  organization?: string;
  project?: string;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = "openai";
  private api_key: string;
  private base_url: string;
  private default_headers: Record<string, string>;
  private timeout: number;

  constructor(opts: OpenAIAdapterOptions) {
    this.api_key = opts.api_key;
    this.base_url = (opts.base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.timeout = opts.timeout ?? 120_000;
    this.default_headers = { ...opts.default_headers };
    if (opts.organization) this.default_headers["OpenAI-Organization"] = opts.organization;
    if (opts.project) this.default_headers["OpenAI-Project"] = opts.project;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.api_key}`,
      ...this.default_headers,
    };
  }

  private buildRequestBody(request: Request): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
    };

    // Extract system/developer messages as instructions
    const instructions = request.messages
      .filter((m) => m.role === Role.SYSTEM || m.role === Role.DEVELOPER)
      .map((m) => m.text)
      .join("\n\n");
    if (instructions) {
      body.instructions = instructions;
    }

    // Build input array
    const input: unknown[] = [];
    for (const msg of request.messages) {
      if (msg.role === Role.SYSTEM || msg.role === Role.DEVELOPER) continue;

      if (msg.role === Role.TOOL) {
        // Tool results are top-level input items
        for (const part of msg.content) {
          if (part.kind === ContentKind.TOOL_RESULT && part.tool_result) {
            input.push({
              type: "function_call_output",
              call_id: part.tool_result.tool_call_id,
              output:
                typeof part.tool_result.content === "string"
                  ? part.tool_result.content
                  : JSON.stringify(part.tool_result.content),
            });
          }
        }
        continue;
      }

      if (msg.role === Role.ASSISTANT) {
        // Assistant messages: text parts as message, tool calls as function_call items
        const textParts = msg.content.filter((p) => p.kind === ContentKind.TEXT);
        const toolCallParts = msg.content.filter((p) => p.kind === ContentKind.TOOL_CALL);

        if (textParts.length > 0) {
          input.push({
            type: "message",
            role: "assistant",
            content: textParts.map((p) => ({
              type: "output_text",
              text: p.text ?? "",
            })),
          });
        }

        for (const p of toolCallParts) {
          if (p.tool_call) {
            input.push({
              type: "function_call",
              id: p.tool_call.id,
              name: p.tool_call.name,
              arguments:
                typeof p.tool_call.arguments === "string"
                  ? p.tool_call.arguments
                  : JSON.stringify(p.tool_call.arguments),
            });
          }
        }
        continue;
      }

      // USER messages
      const content: unknown[] = [];
      for (const part of msg.content) {
        switch (part.kind) {
          case ContentKind.TEXT:
            content.push({ type: "input_text", text: part.text ?? "" });
            break;
          case ContentKind.IMAGE:
            if (part.image) {
              if (part.image.url) {
                content.push({
                  type: "input_image",
                  image_url: part.image.url,
                  ...(part.image.detail ? { detail: part.image.detail } : {}),
                });
              } else if (part.image.data) {
                const mime = part.image.media_type ?? "image/png";
                content.push({
                  type: "input_image",
                  image_url: `data:${mime};base64,${part.image.data}`,
                  ...(part.image.detail ? { detail: part.image.detail } : {}),
                });
              }
            }
            break;
          default:
            if (part.kind === ContentKind.TOOL_CALL && part.tool_call) {
              // Shouldn't happen in user messages but handle gracefully
              content.push({ type: "input_text", text: JSON.stringify(part.tool_call) });
            }
        }
      }

      if (content.length > 0) {
        input.push({
          type: "message",
          role: "user",
          content,
        });
      }
    }

    body.input = input;

    // Tools
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(translateToolDefinition);
    }

    // Tool choice
    if (request.tool_choice) {
      body.tool_choice = translateToolChoice(request.tool_choice);
    }

    // Generation parameters
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.top_p != null) body.top_p = request.top_p;
    if (request.max_tokens != null) body.max_output_tokens = request.max_tokens;

    // Reasoning effort
    if (request.reasoning_effort && request.reasoning_effort !== "none") {
      body.reasoning = { effort: request.reasoning_effort };
    }

    // Response format
    if (request.response_format) {
      if (request.response_format.type === "json_schema" && request.response_format.json_schema) {
        body.text = {
          format: {
            type: "json_schema",
            schema: request.response_format.json_schema,
            ...(request.response_format.strict ? { strict: true } : {}),
          },
        };
      } else if (request.response_format.type === "json") {
        body.text = { format: { type: "json_object" } };
      }
    }

    // Provider options
    const providerOpts = request.provider_options?.openai;
    if (providerOpts) {
      for (const [key, value] of Object.entries(providerOpts)) {
        if (!(key in body)) {
          body[key] = value;
        }
      }
    }

    return body;
  }

  async complete(request: Request): Promise<LLMResponse> {
    const body = this.buildRequestBody(request);
    const url = `${this.base_url}/responses`;

    const httpResp = await httpRequest({
      url,
      headers: this.headers(),
      body,
      timeout: this.timeout,
    });

    raiseForStatus(httpResp.status, httpResp.headers, httpResp.body, this.name);

    const data = httpResp.body as Record<string, unknown>;
    return this.parseResponse(data, httpResp.headers);
  }

  async *stream(request: Request): AsyncGenerator<StreamEvent> {
    const body = this.buildRequestBody(request);
    body.stream = true;
    const url = `${this.base_url}/responses`;

    const httpResp = await httpStreamRequest({
      url,
      headers: this.headers(),
      body,
      timeout: this.timeout,
    });

    // Check for error status
    if (httpResp.status >= 400) {
      const reader = httpResp.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      raiseForStatus(httpResp.status, httpResp.headers, parsed, this.name);
    }

    yield { type: StreamEventType.STREAM_START };

    // Accumulate state for FINISH event
    let fullText = "";
    let finishReason: FinishReason | undefined;
    let usage: Usage | undefined;
    let responseId = "";
    let modelUsed = request.model;
    const contentParts: ContentPart[] = [];
    const toolCalls = new Map<string, { id: string; name: string; args: string }>();
    let currentTextStarted = false;
    let thinkingText = "";

    for await (const sseEvent of parseSSEStream(httpResp.body)) {
      if (sseEvent.data === "[DONE]") break;

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(sseEvent.data);
      } catch {
        continue;
      }

      const eventType = (sseEvent.event ?? data.type) as string;

      switch (eventType) {
        case "response.created":
        case "response.in_progress": {
          const resp = (data.response ?? data) as Record<string, unknown>;
          if (resp.id) responseId = resp.id as string;
          if (resp.model) modelUsed = resp.model as string;
          break;
        }

        case "response.output_text.delta": {
          const delta = data.delta as string;
          if (!currentTextStarted) {
            currentTextStarted = true;
            yield { type: StreamEventType.TEXT_START, text_id: "text_0" };
          }
          fullText += delta;
          yield { type: StreamEventType.TEXT_DELTA, delta, text_id: "text_0" };
          break;
        }

        case "response.output_text.done": {
          if (currentTextStarted) {
            yield { type: StreamEventType.TEXT_END, text_id: "text_0" };
            contentParts.push({ kind: ContentKind.TEXT, text: fullText });
          }
          break;
        }

        case "response.function_call_arguments.delta": {
          const callId = (data.item_id ?? data.call_id ?? "") as string;
          const argDelta = data.delta as string;
          const existing = toolCalls.get(callId);
          if (existing) {
            existing.args += argDelta;
          }
          yield {
            type: StreamEventType.TOOL_CALL_DELTA,
            tool_call: { id: callId, arguments: {} },
            raw: data,
          };
          break;
        }

        case "response.output_item.added": {
          const item = data.item as Record<string, unknown>;
          if (item?.type === "function_call") {
            const callId = item.id as string;
            const name = item.name as string;
            toolCalls.set(callId, { id: callId, name, args: "" });
            yield {
              type: StreamEventType.TOOL_CALL_START,
              tool_call: { id: callId, name, arguments: {} },
            };
          }
          break;
        }

        case "response.output_item.done": {
          const item = data.item as Record<string, unknown>;
          if (item?.type === "function_call") {
            const callId = item.id as string;
            const tc = toolCalls.get(callId);
            if (tc) {
              const rawArgs = (item.arguments as string) ?? tc.args;
              let parsedArgs: Record<string, unknown> = {};
              try { parsedArgs = JSON.parse(rawArgs); } catch { /* keep empty */ }
              contentParts.push({
                kind: ContentKind.TOOL_CALL,
                tool_call: {
                  id: callId,
                  name: tc.name,
                  arguments: parsedArgs,
                },
              });
              yield {
                type: StreamEventType.TOOL_CALL_END,
                tool_call: { id: callId, name: tc.name, arguments: parsedArgs },
              };
            }
          }
          break;
        }

        case "response.completed": {
          const resp = (data.response ?? data) as Record<string, unknown>;
          if (resp.id) responseId = resp.id as string;
          if (resp.model) modelUsed = resp.model as string;

          // Parse usage
          const usageData = resp.usage as Record<string, unknown> | undefined;
          if (usageData) {
            const outputDetails = usageData.output_tokens_details as Record<string, unknown> | undefined;
            const inputDetails = usageData.prompt_tokens_details as Record<string, unknown> | undefined;
            usage = new Usage({
              input_tokens: (usageData.input_tokens ?? usageData.prompt_tokens ?? 0) as number,
              output_tokens: (usageData.output_tokens ?? usageData.completion_tokens ?? 0) as number,
              total_tokens: (usageData.total_tokens ?? 0) as number,
              reasoning_tokens: (outputDetails?.reasoning_tokens as number) ?? undefined,
              cache_read_tokens: (inputDetails?.cached_tokens as number) ?? undefined,
              raw: usageData,
            });
          }

          // Parse finish reason
          const rawStatus = resp.status as string;
          finishReason = mapFinishReason(rawStatus, toolCalls.size > 0);
          break;
        }
      }
    }

    // Ensure text parts are in content
    if (contentParts.length === 0 && fullText) {
      contentParts.push({ kind: ContentKind.TEXT, text: fullText });
    }

    const finalUsage = usage ?? Usage.zero();
    const finalFinishReason = finishReason ?? { reason: "stop" as const, raw: "stop" };

    const message = new Message({
      role: Role.ASSISTANT,
      content: contentParts,
    });

    const response = new LLMResponse({
      id: responseId,
      model: modelUsed,
      provider: this.name,
      message,
      finish_reason: finalFinishReason,
      usage: finalUsage,
    });

    yield {
      type: StreamEventType.FINISH,
      finish_reason: finalFinishReason,
      usage: finalUsage,
      response,
    };
  }

  private parseResponse(data: Record<string, unknown>, headers: Headers): LLMResponse {
    const responseId = (data.id ?? "") as string;
    const model = (data.model ?? "") as string;

    // Parse output items
    const output = (data.output ?? []) as Record<string, unknown>[];
    const contentParts: ContentPart[] = [];
    let hasToolCalls = false;

    for (const item of output) {
      const itemType = item.type as string;
      if (itemType === "message") {
        const msgContent = (item.content ?? []) as Record<string, unknown>[];
        for (const part of msgContent) {
          if (part.type === "output_text") {
            contentParts.push({ kind: ContentKind.TEXT, text: part.text as string });
          }
        }
      } else if (itemType === "function_call") {
        hasToolCalls = true;
        let parsedArgs: Record<string, unknown> = {};
        const rawArgs = item.arguments as string;
        try { parsedArgs = JSON.parse(rawArgs); } catch { /* keep empty */ }
        contentParts.push({
          kind: ContentKind.TOOL_CALL,
          tool_call: {
            id: item.id as string,
            name: item.name as string,
            arguments: parsedArgs,
          },
        });
      }
    }

    // Usage
    const usageData = data.usage as Record<string, unknown> | undefined;
    let usageObj = Usage.zero();
    if (usageData) {
      const outputDetails = usageData.output_tokens_details as Record<string, unknown> | undefined;
      const inputDetails = usageData.prompt_tokens_details as Record<string, unknown> | undefined;
      usageObj = new Usage({
        input_tokens: (usageData.input_tokens ?? usageData.prompt_tokens ?? 0) as number,
        output_tokens: (usageData.output_tokens ?? usageData.completion_tokens ?? 0) as number,
        total_tokens: (usageData.total_tokens ?? 0) as number,
        reasoning_tokens: (outputDetails?.reasoning_tokens as number) ?? undefined,
        cache_read_tokens: (inputDetails?.cached_tokens as number) ?? undefined,
        raw: usageData,
      });
    }

    // Finish reason
    const rawStatus = (data.status ?? "completed") as string;
    const finishReason = mapFinishReason(rawStatus, hasToolCalls);

    // Rate limit info
    const rateLimitInfo = parseRateLimitHeaders(headers);

    const message = new Message({
      role: Role.ASSISTANT,
      content: contentParts,
    });

    return new LLMResponse({
      id: responseId,
      model,
      provider: this.name,
      message,
      finish_reason: finishReason,
      usage: usageObj,
      raw: data,
      rate_limit: rateLimitInfo,
    });
  }
}

function translateToolDefinition(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function translateToolChoice(choice: ToolChoice): unknown {
  switch (choice.mode) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "required":
      return "required";
    case "named":
      return { type: "function", function: { name: choice.tool_name } };
  }
}

function mapFinishReason(rawStatus: string, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return { reason: "tool_calls", raw: rawStatus };

  switch (rawStatus) {
    case "completed":
    case "stop":
      return { reason: "stop", raw: rawStatus };
    case "length":
    case "incomplete":
      return { reason: "length", raw: rawStatus };
    case "tool_calls":
      return { reason: "tool_calls", raw: rawStatus };
    case "content_filter":
      return { reason: "content_filter", raw: rawStatus };
    default:
      return { reason: "other", raw: rawStatus };
  }
}
