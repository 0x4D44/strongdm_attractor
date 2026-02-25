import { describe, it, expect } from "vitest";
import { parseSSEStream } from "./sse.js";
import { StreamError } from "../types.js";
import type { SSEEvent } from "./sse.js";

// Helper: create a ReadableStream from string chunks
function makeStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
  });
}

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of parseSSEStream(stream)) {
    events.push(event);
  }
  return events;
}

describe("parseSSEStream()", () => {
  it("parses a single well-formed SSE event", async () => {
    const stream = makeStream('data: {"hello":"world"}\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"hello":"world"}');
  });

  it("parses multiple events", async () => {
    const stream = makeStream('data: first\n\ndata: second\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("first");
    expect(events[1].data).toBe("second");
  });

  it("handles multi-line data fields", async () => {
    const stream = makeStream('data: line1\ndata: line2\ndata: line3\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("line1\nline2\nline3");
  });

  it("handles event: field", async () => {
    const stream = makeStream('event: message_start\ndata: {"type":"start"}\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("message_start");
    expect(events[0].data).toBe('{"type":"start"}');
  });

  it("handles id: field", async () => {
    const stream = makeStream('id: evt_123\ndata: hello\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("evt_123");
  });

  it("handles retry: field", async () => {
    const stream = makeStream('retry: 5000\ndata: reconnect\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].retry).toBe(5000);
  });

  it("ignores invalid retry values", async () => {
    const stream = makeStream('retry: abc\ndata: hello\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].retry).toBeUndefined();
  });

  it("skips comment lines (: prefix)", async () => {
    const stream = makeStream(': this is a comment\ndata: actual data\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("actual data");
  });

  it("handles [DONE] as regular data (not special at SSE level)", async () => {
    // [DONE] is handled by the consumer, not the SSE parser
    const stream = makeStream('data: [DONE]\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("[DONE]");
  });

  it("handles empty data lines", async () => {
    const stream = makeStream('data: \n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("");
  });

  it("handles data split across chunks", async () => {
    const stream = makeStream('data: hel', 'lo\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
  });

  it("handles \\r\\n line endings", async () => {
    const stream = makeStream('data: hello\r\n\r\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
  });

  it("skips events with no data", async () => {
    const stream = makeStream('event: ping\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(0);
  });

  it("handles fields without values", async () => {
    // Per SSE spec: field with no colon has empty value
    const stream = makeStream('data\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("");
  });

  it("handles space after colon in field value", async () => {
    const stream = makeStream('data: hello\n\n');
    const events = await collectEvents(stream);
    expect(events[0].data).toBe("hello");
  });

  it("handles no space after colon", async () => {
    const stream = makeStream('data:hello\n\n');
    const events = await collectEvents(stream);
    expect(events[0].data).toBe("hello");
  });

  it("handles data remaining in buffer after stream ends", async () => {
    // No trailing \n\n — data left in buffer
    const stream = makeStream('data: leftover');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("leftover");
  });

  it("handles complex interleaved event", async () => {
    const stream = makeStream(
      'event: content_block_start\ndata: {"index":0}\n\n' +
      ': keepalive\n' +
      'event: content_block_delta\ndata: {"delta":"hi"}\n\n'
    );
    const events = await collectEvents(stream);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("content_block_start");
    expect(events[0].data).toBe('{"index":0}');
    expect(events[1].event).toBe("content_block_delta");
    expect(events[1].data).toBe('{"delta":"hi"}');
  });

  it("handles empty stream", async () => {
    const stream = makeStream('');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(0);
  });

  it("wraps stream reader error in StreamError", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("Network failure"));
      },
    });

    await expect(collectEvents(stream)).rejects.toThrow(StreamError);
    await expect(collectEvents(
      new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new Error("Network failure")); },
      }),
    )).rejects.toThrow("SSE stream error: Network failure");
  });

  it("wraps non-Error stream reader error in StreamError", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error("string error");
      },
    });

    await expect(collectEvents(stream)).rejects.toThrow(StreamError);
    await expect(collectEvents(
      new ReadableStream<Uint8Array>({
        pull(controller) { controller.error("string error"); },
      }),
    )).rejects.toThrow("SSE stream error: string error");
  });

  it("handles buffer with event and data remaining after stream ends", async () => {
    // Data in buffer with event: prefix but no trailing \n\n
    const stream = makeStream('event: custom\ndata: trailing');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("custom");
    expect(events[0].data).toBe("trailing");
  });

  it("handles buffer with comment and blank lines remaining", async () => {
    const stream = makeStream('data: first\n\n: comment\n\ndata: second');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("first");
    expect(events[1].data).toBe("second");
  });

  it("handles buffer flush with empty line boundary", async () => {
    // Buffer ends with blank line triggering flush
    const stream = makeStream('data: hello\n\n');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
  });

  it("skips comment lines in buffer flush", async () => {
    // Comment remaining in buffer after stream ends
    const stream = makeStream(': just a comment');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(0);
  });

  it("handles multiple events split across multiple chunks", async () => {
    const stream = makeStream(
      'event: a\nda',
      'ta: first\n\neve',
      'nt: b\ndata: second\n\n',
    );
    const events = await collectEvents(stream);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("a");
    expect(events[0].data).toBe("first");
    expect(events[1].event).toBe("b");
    expect(events[1].data).toBe("second");
  });

  it("handles buffer flush with blank line boundary yielding an event", async () => {
    // Buffer contains "data: from-buffer\n\n" (two events separated by blank line in buffer)
    // The trailing data can't be processed in the main loop because it's in one chunk
    // that doesn't end with \n so the last piece stays in the buffer
    const stream = makeStream('data: a\n\ndata: b');
    const events = await collectEvents(stream);
    // 'a' gets flushed in main loop by blank line, 'b' gets flushed from buffer
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("a");
    expect(events[1].data).toBe("b");
  });

  it("handles field without colon in buffer flush", async () => {
    // A field with no colon remaining in buffer
    const stream = makeStream('data');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("");
  });

  it("handles event: set in main loop with data: in buffer flush", async () => {
    const stream = makeStream('data: first\n\nevent: custom\ndata: buf');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("first");
    expect(events[1].event).toBe("custom");
    expect(events[1].data).toBe("buf");
  });

  it("handles blank line in buffer flush via trailing carriage return", async () => {
    // Chunk ends with \r (no \n after it). After main-loop split on \n,
    // buffer = "\r". In buffer flush, split on \n gives ["\r"], trimmed = "" → blank line → flushEvent.
    const stream = makeStream('data: hello\r\n\r');
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
  });

  it("handles buffer flush with blank line separating two events in remaining buffer", async () => {
    // The buffer flush path can encounter a blank line boundary
    // This means: data + blank line + more data, all in the remaining buffer
    const encoder = new TextEncoder();
    let index = 0;
    const chunks = ['data: main\n\n'];
    // After main loop processes first chunk fully, the second chunk stays in buffer
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index++]));
        } else {
          controller.close();
        }
      },
    });
    const events = await collectEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("main");
  });

  it("flushes buffer at end of stream with event and retry fields", async () => {
    // Exercise the buffer flush path where field === "event" (line 136)
    // and field is "retry"/"id" (neither "data" nor "event" — falls through both)
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Complete event
        controller.enqueue(encoder.encode("event: custom\ndata: hello\n\n"));
        // Incomplete event in buffer at stream end: retry + id + event + data without trailing \n\n
        controller.enqueue(encoder.encode("retry: 1000\nid: msg1\nevent: final\ndata: buffered"));
        controller.close();
      },
    });
    const events = await collectEvents(stream);
    // Two events: the first complete one, and the buffered one flushed at end
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("custom");
    expect(events[0].data).toBe("hello");
    expect(events[1].event).toBe("final");
    expect(events[1].data).toBe("buffered");
  });
});
