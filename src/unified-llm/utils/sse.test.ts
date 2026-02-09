import { describe, it, expect } from "vitest";
import { parseSSEStream } from "./sse.js";
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
});
