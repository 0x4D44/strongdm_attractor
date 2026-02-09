// ============================================================================
// Server-Sent Events (SSE) Parser
// ============================================================================

import { StreamError } from "../types.js";

export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Parses a ReadableStream of SSE bytes into an async iterable of SSEEvent objects.
 * Handles multi-line data fields, event types, comments, and blank-line boundaries.
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let currentEvent: string | undefined;
  let currentData: string[] = [];
  let currentId: string | undefined;
  let currentRetry: number | undefined;

  function flushEvent(): SSEEvent | null {
    if (currentData.length === 0) {
      // Reset fields even if no data
      currentEvent = undefined;
      currentId = undefined;
      currentRetry = undefined;
      return null;
    }

    const event: SSEEvent = {
      data: currentData.join("\n"),
    };
    if (currentEvent !== undefined) event.event = currentEvent;
    if (currentId !== undefined) event.id = currentId;
    if (currentRetry !== undefined) event.retry = currentRetry;

    currentEvent = undefined;
    currentData = [];
    currentId = undefined;
    currentRetry = undefined;

    return event;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      // Keep incomplete last line in buffer
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.replace(/\r$/, ""); // Handle \r\n

        if (trimmed === "") {
          // Blank line = event boundary
          const event = flushEvent();
          if (event) yield event;
          continue;
        }

        if (trimmed.startsWith(":")) {
          // Comment, skip
          continue;
        }

        const colonIndex = trimmed.indexOf(":");
        let field: string;
        let value: string;

        if (colonIndex === -1) {
          field = trimmed;
          value = "";
        } else {
          field = trimmed.substring(0, colonIndex);
          value = trimmed.substring(colonIndex + 1);
          // Remove leading space after colon
          if (value.startsWith(" ")) value = value.substring(1);
        }

        switch (field) {
          case "event":
            currentEvent = value;
            break;
          case "data":
            currentData.push(value);
            break;
          case "id":
            currentId = value;
            break;
          case "retry": {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed)) currentRetry = parsed;
            break;
          }
          // Unknown fields are ignored per spec
        }
      }
    }

    // Flush remaining buffer
    if (buffer.length > 0) {
      const lines = buffer.split("\n");
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, "");
        if (trimmed === "") {
          const event = flushEvent();
          if (event) yield event;
        } else if (!trimmed.startsWith(":")) {
          const colonIndex = trimmed.indexOf(":");
          let field: string;
          let value: string;
          if (colonIndex === -1) {
            field = trimmed;
            value = "";
          } else {
            field = trimmed.substring(0, colonIndex);
            value = trimmed.substring(colonIndex + 1);
            if (value.startsWith(" ")) value = value.substring(1);
          }
          if (field === "data") currentData.push(value);
          else if (field === "event") currentEvent = value;
        }
      }
      // Final flush
      const event = flushEvent();
      if (event) yield event;
    }
  } catch (err: unknown) {
    throw new StreamError(
      `SSE stream error: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  } finally {
    reader.releaseLock();
  }
}
