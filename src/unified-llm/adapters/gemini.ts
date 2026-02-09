// ============================================================================
// Gemini Adapter — Native Gemini API (/v1beta/models/*)
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
import { randomUUID } from "node:crypto";

export interface GeminiAdapterOptions {
  api_key: string;
  base_url?: string;
  default_headers?: Record<string, string>;
  timeout?: number;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly name = "gemini";
  private api_key: string;
  private base_url: string;
  private default_headers: Record<string, string>;
  private timeout: number;
  // Track synthetic IDs -> function names for tool result mapping
  private toolCallNameMap = new Map<string, string>();

  constructor(opts: GeminiAdapterOptions) {
    this.api_key = opts.api_key;
    this.base_url = (opts.base_url ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.timeout = opts.timeout ?? 120_000;
    this.default_headers = { ...opts.default_headers };
  }

  private headers(): Record<string, string> {
    return {
      ...this.default_headers,
    };
  }

  private buildRequestBody(request: Request): Record<string, unknown> {
    const body: Record<string, unknown> = {};

    // Extract system messages into systemInstruction
    const systemTexts: string[] = [];
    for (const msg of request.messages) {
      if (msg.role === Role.SYSTEM || msg.role === Role.DEVELOPER) {
        systemTexts.push(msg.text);
      }
    }
    if (systemTexts.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemTexts.join("\n\n") }],
      };
    }

    // Build contents array
    const contents: unknown[] = [];
    const conversationMsgs = request.messages.filter(
      (m) => m.role !== Role.SYSTEM && m.role !== Role.DEVELOPER,
    );

    for (const msg of conversationMsgs) {
      const geminiRole = msg.role === Role.ASSISTANT ? "model" : "user";
      const parts = translateMessageParts(msg, this.toolCallNameMap);

      if (parts.length === 0) continue;

      // Merge consecutive same-role messages
      if (contents.length > 0) {
        const last = contents[contents.length - 1] as Record<string, unknown>;
        if (last.role === geminiRole) {
          (last.parts as unknown[]).push(...parts);
          continue;
        }
      }

      contents.push({ role: geminiRole, parts });
    }

    body.contents = contents;

    // Generation config
    const generationConfig: Record<string, unknown> = {};
    if (request.temperature != null) generationConfig.temperature = request.temperature;
    if (request.top_p != null) generationConfig.topP = request.top_p;
    if (request.max_tokens != null) generationConfig.maxOutputTokens = request.max_tokens;
    if (request.stop_sequences) generationConfig.stopSequences = request.stop_sequences;

    // Response format
    if (request.response_format) {
      if (request.response_format.type === "json_schema" && request.response_format.json_schema) {
        generationConfig.responseMimeType = "application/json";
        generationConfig.responseSchema = request.response_format.json_schema;
      } else if (request.response_format.type === "json") {
        generationConfig.responseMimeType = "application/json";
      }
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    // Tools
    if (request.tools && request.tools.length > 0) {
      if (request.tool_choice?.mode !== "none") {
        body.tools = [
          {
            functionDeclarations: request.tools.map(translateToolDefinition),
          },
        ];
      }
    }

    // Tool config (tool choice)
    if (request.tool_choice && request.tool_choice.mode !== "auto") {
      body.toolConfig = { functionCallingConfig: translateToolChoice(request.tool_choice) };
    }

    // Thinking config
    const providerOpts = request.provider_options?.gemini;
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
    const url = `${this.base_url}/models/${request.model}:generateContent?key=${this.api_key}`;

    const httpResp = await httpRequest({
      url,
      headers: this.headers(),
      body,
      timeout: this.timeout,
    });

    raiseForStatus(httpResp.status, httpResp.headers, httpResp.body, this.name);

    const data = httpResp.body as Record<string, unknown>;
    return this.parseResponse(data, httpResp.headers, request.model);
  }

  async *stream(request: Request): AsyncGenerator<StreamEvent> {
    const body = this.buildRequestBody(request);
    const url = `${this.base_url}/models/${request.model}:streamGenerateContent?key=${this.api_key}&alt=sse`;

    const httpResp = await httpStreamRequest({
      url,
      headers: this.headers(),
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

    let fullText = "";
    let textStarted = false;
    let finishReason: FinishReason | undefined;
    let usage: Usage | undefined;
    const contentParts: ContentPart[] = [];
    let thinkingText = "";
    let thinkingStarted = false;

    for await (const sseEvent of parseSSEStream(httpResp.body)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(sseEvent.data);
      } catch {
        continue;
      }

      const candidates = data.candidates as Record<string, unknown>[] | undefined;
      if (candidates && candidates.length > 0) {
        const candidate = candidates[0];
        const content = candidate.content as Record<string, unknown> | undefined;

        if (content) {
          const parts = (content.parts ?? []) as Record<string, unknown>[];
          for (const part of parts) {
            if (part.thought) {
              // Thinking part
              const text = part.text as string;
              if (!thinkingStarted) {
                thinkingStarted = true;
                yield { type: StreamEventType.REASONING_START };
              }
              thinkingText += text;
              yield { type: StreamEventType.REASONING_DELTA, reasoning_delta: text };
            } else if (part.text != null) {
              const text = part.text as string;
              if (!textStarted) {
                // Close thinking if it was started
                if (thinkingStarted) {
                  contentParts.push({
                    kind: ContentKind.THINKING,
                    thinking: { text: thinkingText },
                  });
                  yield { type: StreamEventType.REASONING_END };
                  thinkingStarted = false;
                }
                textStarted = true;
                yield { type: StreamEventType.TEXT_START, text_id: "text_0" };
              }
              fullText += text;
              yield { type: StreamEventType.TEXT_DELTA, delta: text, text_id: "text_0" };
            } else if (part.functionCall) {
              const fc = part.functionCall as Record<string, unknown>;
              const name = fc.name as string;
              const args = (fc.args ?? {}) as Record<string, unknown>;
              const callId = `call_${randomUUID()}`;
              this.toolCallNameMap.set(callId, name);

              contentParts.push({
                kind: ContentKind.TOOL_CALL,
                tool_call: { id: callId, name, arguments: args },
              });

              yield {
                type: StreamEventType.TOOL_CALL_START,
                tool_call: { id: callId, name, arguments: args },
              };
              yield {
                type: StreamEventType.TOOL_CALL_END,
                tool_call: { id: callId, name, arguments: args },
              };
            }
          }
        }

        // Check finish reason
        const rawFinishReason = candidate.finishReason as string | undefined;
        if (rawFinishReason) {
          finishReason = mapFinishReason(rawFinishReason, contentParts.some(p => p.kind === ContentKind.TOOL_CALL));
        }
      }

      // Usage metadata
      const usageMetadata = data.usageMetadata as Record<string, unknown> | undefined;
      if (usageMetadata) {
        usage = new Usage({
          input_tokens: (usageMetadata.promptTokenCount ?? 0) as number,
          output_tokens: (usageMetadata.candidatesTokenCount ?? 0) as number,
          total_tokens: (usageMetadata.totalTokenCount ?? 0) as number,
          reasoning_tokens: usageMetadata.thoughtsTokenCount as number | undefined,
          cache_read_tokens: usageMetadata.cachedContentTokenCount as number | undefined,
          raw: usageMetadata,
        });
      }
    }

    // Close open segments
    if (thinkingStarted) {
      contentParts.push({
        kind: ContentKind.THINKING,
        thinking: { text: thinkingText },
      });
      yield { type: StreamEventType.REASONING_END };
    }

    if (textStarted) {
      contentParts.push({ kind: ContentKind.TEXT, text: fullText });
      yield { type: StreamEventType.TEXT_END, text_id: "text_0" };
    } else if (fullText) {
      contentParts.push({ kind: ContentKind.TEXT, text: fullText });
    }

    const finalUsage = usage ?? Usage.zero();
    const finalFinishReason = finishReason ?? { reason: "stop" as const, raw: "STOP" };

    const message = new Message({
      role: Role.ASSISTANT,
      content: contentParts,
    });

    const response = new LLMResponse({
      id: `gemini_${randomUUID()}`,
      model: request.model,
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

  private parseResponse(data: Record<string, unknown>, headers: Headers, model: string): LLMResponse {
    const candidates = (data.candidates ?? []) as Record<string, unknown>[];
    const contentParts: ContentPart[] = [];
    let hasToolCalls = false;
    let rawFinishReason: string | undefined;

    if (candidates.length > 0) {
      const candidate = candidates[0];
      rawFinishReason = candidate.finishReason as string | undefined;
      const content = candidate.content as Record<string, unknown> | undefined;

      if (content) {
        const parts = (content.parts ?? []) as Record<string, unknown>[];
        for (const part of parts) {
          if (part.thought) {
            contentParts.push({
              kind: ContentKind.THINKING,
              thinking: { text: part.text as string },
            });
          } else if (part.text != null) {
            contentParts.push({ kind: ContentKind.TEXT, text: part.text as string });
          } else if (part.functionCall) {
            hasToolCalls = true;
            const fc = part.functionCall as Record<string, unknown>;
            const name = fc.name as string;
            const args = (fc.args ?? {}) as Record<string, unknown>;
            const callId = `call_${randomUUID()}`;
            this.toolCallNameMap.set(callId, name);

            contentParts.push({
              kind: ContentKind.TOOL_CALL,
              tool_call: { id: callId, name, arguments: args },
            });
          }
        }
      }
    }

    // Usage
    const usageMetadata = data.usageMetadata as Record<string, unknown> | undefined;
    let usageObj = Usage.zero();
    if (usageMetadata) {
      usageObj = new Usage({
        input_tokens: (usageMetadata.promptTokenCount ?? 0) as number,
        output_tokens: (usageMetadata.candidatesTokenCount ?? 0) as number,
        total_tokens: (usageMetadata.totalTokenCount ?? 0) as number,
        reasoning_tokens: usageMetadata.thoughtsTokenCount as number | undefined,
        cache_read_tokens: usageMetadata.cachedContentTokenCount as number | undefined,
        raw: usageMetadata,
      });
    }

    // Finish reason
    const finishReason = mapFinishReason(rawFinishReason ?? "STOP", hasToolCalls);

    const rateLimitInfo = parseRateLimitHeaders(headers);

    const message = new Message({
      role: Role.ASSISTANT,
      content: contentParts,
    });

    return new LLMResponse({
      id: `gemini_${randomUUID()}`,
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

function translateMessageParts(
  msg: Message,
  toolCallNameMap: Map<string, string>,
): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];

  for (const part of msg.content) {
    switch (part.kind) {
      case ContentKind.TEXT:
        parts.push({ text: part.text ?? "" });
        break;

      case ContentKind.IMAGE:
        if (part.image) {
          if (part.image.url) {
            parts.push({
              fileData: {
                mimeType: part.image.media_type ?? "image/png",
                fileUri: part.image.url,
              },
            });
          } else if (part.image.data) {
            parts.push({
              inlineData: {
                mimeType: part.image.media_type ?? "image/png",
                data: part.image.data,
              },
            });
          }
        }
        break;

      case ContentKind.DOCUMENT:
        if (part.document?.data) {
          parts.push({
            inlineData: {
              mimeType: part.document.media_type ?? "application/pdf",
              data: part.document.data,
            },
          });
        }
        break;

      case ContentKind.TOOL_CALL:
        if (part.tool_call) {
          parts.push({
            functionCall: {
              name: part.tool_call.name,
              args:
                typeof part.tool_call.arguments === "string"
                  ? JSON.parse(part.tool_call.arguments)
                  : part.tool_call.arguments,
            },
          });
        }
        break;

      case ContentKind.TOOL_RESULT:
        if (part.tool_result) {
          // Gemini uses function name, not call ID
          const funcName = toolCallNameMap.get(part.tool_result.tool_call_id) ?? part.tool_result.tool_call_id;
          const response =
            typeof part.tool_result.content === "string"
              ? { result: part.tool_result.content }
              : part.tool_result.content;
          parts.push({
            functionResponse: {
              name: funcName,
              response,
            },
          });
        }
        break;

      case ContentKind.THINKING:
        if (part.thinking) {
          parts.push({ text: part.thinking.text, thought: true });
        }
        break;
    }
  }

  return parts;
}

function translateToolDefinition(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function translateToolChoice(choice: ToolChoice): Record<string, unknown> {
  switch (choice.mode) {
    case "auto":
      return { mode: "AUTO" };
    case "none":
      return { mode: "NONE" };
    case "required":
      return { mode: "ANY" };
    case "named":
      return { mode: "ANY", allowedFunctionNames: [choice.tool_name] };
  }
}

function mapFinishReason(raw: string, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return { reason: "tool_calls", raw };

  switch (raw) {
    case "STOP":
      return { reason: "stop", raw };
    case "MAX_TOKENS":
      return { reason: "length", raw };
    case "SAFETY":
    case "RECITATION":
      return { reason: "content_filter", raw };
    default:
      return { reason: "other", raw };
  }
}
