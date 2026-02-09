// ============================================================================
// Anthropic Adapter — Messages API (/v1/messages)
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
} from "../types.js";
import { httpRequest, httpStreamRequest, raiseForStatus, parseRateLimitHeaders } from "../utils/http.js";
import { parseSSEStream } from "../utils/sse.js";

export interface AnthropicAdapterOptions {
  api_key: string;
  base_url?: string;
  default_headers?: Record<string, string>;
  timeout?: number;
  api_version?: string;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";
  private api_key: string;
  private base_url: string;
  private default_headers: Record<string, string>;
  private timeout: number;
  private api_version: string;

  constructor(opts: AnthropicAdapterOptions) {
    this.api_key = opts.api_key;
    this.base_url = (opts.base_url ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.timeout = opts.timeout ?? 120_000;
    this.default_headers = { ...opts.default_headers };
    this.api_version = opts.api_version ?? "2023-06-01";
  }

  private headers(request: Request): Record<string, string> {
    const h: Record<string, string> = {
      "x-api-key": this.api_key,
      "anthropic-version": this.api_version,
      ...this.default_headers,
    };

    // Beta headers
    const betaHeaders: string[] = [];
    const providerOpts = request.provider_options?.anthropic as Record<string, unknown> | undefined;
    if (providerOpts?.beta_headers) {
      betaHeaders.push(...(providerOpts.beta_headers as string[]));
    }
    if (providerOpts?.beta_features) {
      betaHeaders.push(...(providerOpts.beta_features as string[]));
    }

    // Auto-add prompt caching beta if auto_cache is not disabled
    const autoCache = providerOpts?.auto_cache !== false;
    if (autoCache) {
      if (!betaHeaders.includes("prompt-caching-2024-07-31")) {
        betaHeaders.push("prompt-caching-2024-07-31");
      }
    }

    // Thinking support
    if (providerOpts?.thinking) {
      if (!betaHeaders.includes("interleaved-thinking-2025-05-14")) {
        betaHeaders.push("interleaved-thinking-2025-05-14");
      }
    }

    if (betaHeaders.length > 0) {
      h["anthropic-beta"] = betaHeaders.join(",");
    }

    return h;
  }

  private buildRequestBody(request: Request): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
    };

    // Extract system messages
    const systemParts: unknown[] = [];
    const providerOpts = request.provider_options?.anthropic as Record<string, unknown> | undefined;
    const autoCache = providerOpts?.auto_cache !== false;

    for (const msg of request.messages) {
      if (msg.role === Role.SYSTEM || msg.role === Role.DEVELOPER) {
        for (const part of msg.content) {
          if (part.kind === ContentKind.TEXT && part.text) {
            const block: Record<string, unknown> = { type: "text", text: part.text };
            systemParts.push(block);
          }
        }
      }
    }
    // Auto-inject cache_control only on the last system block
    if (autoCache && systemParts.length > 0) {
      (systemParts[systemParts.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };
    }
    if (systemParts.length > 0) {
      body.system = systemParts;
    }

    // Build messages array with strict alternation
    const messages: unknown[] = [];
    const conversationMsgs = request.messages.filter(
      (m) => m.role !== Role.SYSTEM && m.role !== Role.DEVELOPER,
    );

    let lastRole: string | null = null;
    for (const msg of conversationMsgs) {
      const anthropicRole = msg.role === Role.TOOL ? "user" : msg.role === Role.ASSISTANT ? "assistant" : "user";
      const content = translateMessageContent(msg, autoCache);

      if (content.length === 0) continue;

      // Merge consecutive same-role messages
      if (anthropicRole === lastRole && messages.length > 0) {
        const lastMsg = messages[messages.length - 1] as Record<string, unknown>;
        (lastMsg.content as unknown[]).push(...content);
      } else {
        messages.push({ role: anthropicRole, content });
        lastRole = anthropicRole;
      }
    }

    // Auto-inject cache_control on last user message content block
    if (autoCache && messages.length > 0) {
      const lastMsg = messages[messages.length - 1] as Record<string, unknown>;
      if (lastMsg.role === "user") {
        const contentArr = lastMsg.content as Record<string, unknown>[];
        if (contentArr.length > 0) {
          contentArr[contentArr.length - 1].cache_control = { type: "ephemeral" };
        }
      }
    }

    body.messages = messages;

    // max_tokens is required for Anthropic
    body.max_tokens = request.max_tokens ?? 4096;

    // Tools
    if (request.tools && request.tools.length > 0) {
      const tools = request.tools.map(translateToolDefinition);
      // Auto-inject cache_control on tool definitions
      if (autoCache && tools.length > 0) {
        (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: "ephemeral" };
      }
      // If tool_choice is none, omit tools entirely (Anthropic quirk)
      if (request.tool_choice?.mode !== "none") {
        body.tools = tools;
      }
    }

    // Tool choice
    if (request.tool_choice && request.tool_choice.mode !== "none") {
      body.tool_choice = translateToolChoice(request.tool_choice);
    }

    // Generation parameters
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.top_p != null) body.top_p = request.top_p;
    if (request.stop_sequences) body.stop_sequences = request.stop_sequences;

    // Extended thinking
    if (providerOpts?.thinking) {
      body.thinking = providerOpts.thinking;
    }

    // Response format - Anthropic doesn't support json_schema natively
    // For structured output, use tool-based extraction or prompt engineering
    // We handle this at the api.ts level

    // Additional provider options
    if (providerOpts) {
      for (const [key, value] of Object.entries(providerOpts)) {
        if (!["beta_headers", "beta_features", "auto_cache", "thinking"].includes(key)) {
          if (!(key in body)) {
            body[key] = value;
          }
        }
      }
    }

    return body;
  }

  async complete(request: Request): Promise<LLMResponse> {
    const body = this.buildRequestBody(request);
    const url = `${this.base_url}/messages`;

    const httpResp = await httpRequest({
      url,
      headers: this.headers(request),
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
    const url = `${this.base_url}/messages`;

    const httpResp = await httpStreamRequest({
      url,
      headers: this.headers(request),
      body,
      timeout: this.timeout,
    });

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

    // Accumulation state
    const contentParts: ContentPart[] = [];
    let currentBlockType: string | undefined;
    let currentBlockIndex = -1;
    let fullText = "";
    let thinkingText = "";
    let thinkingSignature: string | undefined;
    let currentToolCallId = "";
    let currentToolCallName = "";
    let currentToolCallArgs = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    let finishReason: FinishReason | undefined;
    let responseId = "";
    let modelUsed = request.model;

    for await (const sseEvent of parseSSEStream(httpResp.body)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(sseEvent.data);
      } catch {
        continue;
      }

      const eventType = sseEvent.event ?? (data.type as string);

      switch (eventType) {
        case "message_start": {
          const msg = data.message as Record<string, unknown>;
          if (msg) {
            responseId = (msg.id ?? "") as string;
            modelUsed = (msg.model ?? request.model) as string;
            const usageData = msg.usage as Record<string, unknown> | undefined;
            if (usageData) {
              inputTokens = (usageData.input_tokens ?? 0) as number;
              cacheReadTokens = usageData.cache_read_input_tokens as number | undefined;
              cacheWriteTokens = usageData.cache_creation_input_tokens as number | undefined;
            }
          }
          break;
        }

        case "content_block_start": {
          currentBlockIndex = (data.index ?? currentBlockIndex + 1) as number;
          const block = data.content_block as Record<string, unknown>;
          if (block) {
            currentBlockType = block.type as string;
            if (currentBlockType === "text") {
              fullText = "";
              yield { type: StreamEventType.TEXT_START, text_id: `text_${currentBlockIndex}` };
            } else if (currentBlockType === "tool_use") {
              currentToolCallId = (block.id ?? "") as string;
              currentToolCallName = (block.name ?? "") as string;
              currentToolCallArgs = "";
              yield {
                type: StreamEventType.TOOL_CALL_START,
                tool_call: { id: currentToolCallId, name: currentToolCallName, arguments: {} },
              };
            } else if (currentBlockType === "thinking") {
              thinkingText = "";
              thinkingSignature = undefined;
              yield { type: StreamEventType.REASONING_START };
            }
          }
          break;
        }

        case "content_block_delta": {
          const delta = data.delta as Record<string, unknown>;
          if (delta) {
            const deltaType = delta.type as string;
            if (deltaType === "text_delta") {
              const text = delta.text as string;
              fullText += text;
              yield {
                type: StreamEventType.TEXT_DELTA,
                delta: text,
                text_id: `text_${currentBlockIndex}`,
              };
            } else if (deltaType === "input_json_delta") {
              const partial = delta.partial_json as string;
              currentToolCallArgs += partial;
              yield {
                type: StreamEventType.TOOL_CALL_DELTA,
                tool_call: { id: currentToolCallId, name: currentToolCallName, arguments: {} },
                raw: { partial_json: partial },
              };
            } else if (deltaType === "thinking_delta") {
              const text = delta.thinking as string;
              thinkingText += text;
              yield { type: StreamEventType.REASONING_DELTA, reasoning_delta: text };
            }
          }
          break;
        }

        case "content_block_stop": {
          if (currentBlockType === "text") {
            contentParts.push({ kind: ContentKind.TEXT, text: fullText });
            yield { type: StreamEventType.TEXT_END, text_id: `text_${currentBlockIndex}` };
          } else if (currentBlockType === "tool_use") {
            let parsedArgs: Record<string, unknown> = {};
            try { parsedArgs = JSON.parse(currentToolCallArgs); } catch { /* keep empty */ }
            contentParts.push({
              kind: ContentKind.TOOL_CALL,
              tool_call: {
                id: currentToolCallId,
                name: currentToolCallName,
                arguments: parsedArgs,
              },
            });
            yield {
              type: StreamEventType.TOOL_CALL_END,
              tool_call: { id: currentToolCallId, name: currentToolCallName, arguments: parsedArgs },
            };
          } else if (currentBlockType === "thinking") {
            contentParts.push({
              kind: ContentKind.THINKING,
              thinking: {
                text: thinkingText,
                signature: thinkingSignature,
              },
            });
            yield { type: StreamEventType.REASONING_END };
          } else if (currentBlockType === "redacted_thinking") {
            contentParts.push({
              kind: ContentKind.REDACTED_THINKING,
              thinking: { text: "", redacted: true },
            });
          }
          currentBlockType = undefined;
          break;
        }

        case "message_delta": {
          const delta = data.delta as Record<string, unknown> | undefined;
          if (delta) {
            const rawReason = delta.stop_reason as string;
            finishReason = mapFinishReason(rawReason);
          }
          const usageData = data.usage as Record<string, unknown> | undefined;
          if (usageData) {
            outputTokens = (usageData.output_tokens ?? outputTokens) as number;
          }
          break;
        }

        case "message_stop": {
          // Emit FINISH
          break;
        }
      }
    }

    const usage = new Usage({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
    });

    const finalFinishReason = finishReason ?? { reason: "stop" as const, raw: "end_turn" };

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
      usage,
    });

    yield {
      type: StreamEventType.FINISH,
      finish_reason: finalFinishReason,
      usage,
      response,
    };
  }

  private parseResponse(data: Record<string, unknown>, headers: Headers): LLMResponse {
    const responseId = (data.id ?? "") as string;
    const model = (data.model ?? "") as string;

    // Parse content
    const contentArray = (data.content ?? []) as Record<string, unknown>[];
    const contentParts: ContentPart[] = [];
    let hasToolCalls = false;

    for (const block of contentArray) {
      const blockType = block.type as string;
      switch (blockType) {
        case "text":
          contentParts.push({ kind: ContentKind.TEXT, text: block.text as string });
          break;
        case "tool_use": {
          hasToolCalls = true;
          contentParts.push({
            kind: ContentKind.TOOL_CALL,
            tool_call: {
              id: block.id as string,
              name: block.name as string,
              arguments: block.input as Record<string, unknown>,
            },
          });
          break;
        }
        case "thinking":
          contentParts.push({
            kind: ContentKind.THINKING,
            thinking: {
              text: block.thinking as string,
              signature: block.signature as string | undefined,
            },
          });
          break;
        case "redacted_thinking":
          contentParts.push({
            kind: ContentKind.REDACTED_THINKING,
            thinking: {
              text: block.data as string ?? "",
              redacted: true,
            },
          });
          break;
      }
    }

    // Usage
    const usageData = data.usage as Record<string, unknown> | undefined;
    let usageObj = Usage.zero();
    if (usageData) {
      usageObj = new Usage({
        input_tokens: (usageData.input_tokens ?? 0) as number,
        output_tokens: (usageData.output_tokens ?? 0) as number,
        cache_read_tokens: usageData.cache_read_input_tokens as number | undefined,
        cache_write_tokens: usageData.cache_creation_input_tokens as number | undefined,
        raw: usageData,
      });
    }

    // Finish reason
    const rawStopReason = (data.stop_reason ?? "end_turn") as string;
    const finishReason = mapFinishReason(rawStopReason);

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

function translateMessageContent(
  msg: Message,
  autoCache: boolean,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];

  for (const part of msg.content) {
    switch (part.kind) {
      case ContentKind.TEXT:
        result.push({ type: "text", text: part.text ?? "" });
        break;

      case ContentKind.IMAGE:
        if (part.image) {
          if (part.image.url) {
            result.push({
              type: "image",
              source: { type: "url", url: part.image.url },
            });
          } else if (part.image.data) {
            result.push({
              type: "image",
              source: {
                type: "base64",
                media_type: part.image.media_type ?? "image/png",
                data: part.image.data,
              },
            });
          }
        }
        break;

      case ContentKind.DOCUMENT:
        if (part.document) {
          if (part.document.data) {
            result.push({
              type: "document",
              source: {
                type: "base64",
                media_type: part.document.media_type ?? "application/pdf",
                data: part.document.data,
              },
            });
          }
        }
        break;

      case ContentKind.TOOL_CALL:
        if (part.tool_call) {
          result.push({
            type: "tool_use",
            id: part.tool_call.id,
            name: part.tool_call.name,
            input:
              typeof part.tool_call.arguments === "string"
                ? JSON.parse(part.tool_call.arguments)
                : part.tool_call.arguments,
          });
        }
        break;

      case ContentKind.TOOL_RESULT:
        if (part.tool_result) {
          const content =
            typeof part.tool_result.content === "string"
              ? part.tool_result.content
              : JSON.stringify(part.tool_result.content);
          result.push({
            type: "tool_result",
            tool_use_id: part.tool_result.tool_call_id,
            content,
            is_error: part.tool_result.is_error,
          });
        }
        break;

      case ContentKind.THINKING:
        if (part.thinking) {
          result.push({
            type: "thinking",
            thinking: part.thinking.text,
            ...(part.thinking.signature ? { signature: part.thinking.signature } : {}),
          });
        }
        break;

      case ContentKind.REDACTED_THINKING:
        if (part.thinking) {
          result.push({
            type: "redacted_thinking",
            data: part.thinking.text,
          });
        }
        break;
    }
  }

  return result;
}

function translateToolDefinition(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function translateToolChoice(choice: ToolChoice): unknown {
  switch (choice.mode) {
    case "auto":
      return { type: "auto" };
    case "required":
      return { type: "any" };
    case "named":
      return { type: "tool", name: choice.tool_name };
    case "none":
      // Caller should omit tools entirely; this shouldn't be called for none
      return { type: "auto" };
  }
}

function mapFinishReason(raw: string): FinishReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return { reason: "stop", raw };
    case "max_tokens":
      return { reason: "length", raw };
    case "tool_use":
      return { reason: "tool_calls", raw };
    default:
      return { reason: "other", raw };
  }
}
