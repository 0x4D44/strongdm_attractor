/**
 * Property-based / fuzz tests for the SSE stream parser.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseSSEStream } from '../unified-llm/utils/sse.js';
import type { SSEEvent } from '../unified-llm/utils/sse.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a ReadableStream from chunks of Uint8Array. */
function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

/** Create a ReadableStream from a single string. */
function stringStream(data: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return chunkedStream([encoder.encode(data)]);
}

/** Collect all events from an async generator. */
async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of parseSSEStream(stream)) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Arbitrary generators
// ---------------------------------------------------------------------------

/** Generate a valid SSE data value (no newlines). */
const arbSSEValue = fc.array(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 -_.:{}[]"'.split('')),
  { minLength: 0, maxLength: 50 },
).map(arr => arr.join(''));

/** Generate a single SSE event as a string. */
const arbSSEEventStr = fc.tuple(
  fc.option(arbSSEValue, { nil: undefined }),  // event type
  fc.array(arbSSEValue, { minLength: 1, maxLength: 3 }),  // data lines
  fc.option(arbSSEValue, { nil: undefined }),  // id
).map(([eventType, dataLines, id]) => {
  let result = '';
  if (eventType !== undefined) result += `event: ${eventType}\n`;
  for (const line of dataLines) result += `data: ${line}\n`;
  if (id !== undefined) result += `id: ${id}\n`;
  result += '\n'; // blank line terminates event
  return result;
});

/** Generate a full SSE stream string (multiple events). */
const arbSSEStream = fc.array(arbSSEEventStr, { minLength: 1, maxLength: 5 }).map(
  events => events.join(''),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE parser fuzz tests', () => {
  it('never crashes on arbitrary input', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 300 }), async (input) => {
        const stream = stringStream(input);
        const events = await collectEvents(stream);
        expect(events).toBeInstanceOf(Array);
        for (const evt of events) {
          expect(typeof evt.data).toBe('string');
        }
      }),
      { numRuns: 300 },
    );
  });

  it('well-formed SSE events parse with correct data', async () => {
    await fc.assert(
      fc.asyncProperty(arbSSEStream, async (sseStr) => {
        const stream = stringStream(sseStr);
        const events = await collectEvents(stream);
        expect(events.length).toBeGreaterThanOrEqual(1);
        for (const evt of events) {
          expect(typeof evt.data).toBe('string');
          if (evt.event !== undefined) expect(typeof evt.event).toBe('string');
          if (evt.id !== undefined) expect(typeof evt.id).toBe('string');
          if (evt.retry !== undefined) expect(typeof evt.retry).toBe('number');
        }
      }),
      { numRuns: 300 },
    );
  });

  it('handles arbitrary chunking of valid SSE stream', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSSEStream,
        fc.integer({ min: 1, max: 20 }),
        async (sseStr, chunkSize) => {
          const encoder = new TextEncoder();
          const fullBytes = encoder.encode(sseStr);
          const chunks: Uint8Array[] = [];
          for (let i = 0; i < fullBytes.length; i += chunkSize) {
            chunks.push(fullBytes.slice(i, i + chunkSize));
          }

          const chunkedEvents = await collectEvents(chunkedStream(chunks));
          const singleEvents = await collectEvents(stringStream(sseStr));

          expect(chunkedEvents.length).toBe(singleEvents.length);

          for (let i = 0; i < chunkedEvents.length; i++) {
            expect(chunkedEvents[i].data).toBe(singleEvents[i].data);
            expect(chunkedEvents[i].event).toBe(singleEvents[i].event);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('comments (lines starting with :) are ignored', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSSEValue,
        arbSSEValue,
        async (comment, data) => {
          const sseStr = `:${comment}\ndata: ${data}\n\n`;
          const events = await collectEvents(stringStream(sseStr));
          expect(events.length).toBe(1);
          expect(events[0].data).toBe(data);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('blank lines without data produce no events', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        async (count) => {
          const sseStr = '\n'.repeat(count);
          const events = await collectEvents(stringStream(sseStr));
          expect(events.length).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('multi-line data is joined with newlines', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbSSEValue, { minLength: 2, maxLength: 5 }),
        async (lines) => {
          const sseStr = lines.map(l => `data: ${l}`).join('\n') + '\n\n';
          const events = await collectEvents(stringStream(sseStr));
          expect(events.length).toBe(1);
          expect(events[0].data).toBe(lines.join('\n'));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('retry field is parsed as number when valid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 99999 }),
        arbSSEValue,
        async (retry, data) => {
          const sseStr = `retry: ${retry}\ndata: ${data}\n\n`;
          const events = await collectEvents(stringStream(sseStr));
          expect(events.length).toBe(1);
          expect(events[0].retry).toBe(retry);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('handles \\r\\n line endings', async () => {
    await fc.assert(
      fc.asyncProperty(arbSSEValue, async (data) => {
        const sseStr = `data: ${data}\r\n\r\n`;
        const events = await collectEvents(stringStream(sseStr));
        expect(events.length).toBe(1);
        expect(events[0].data).toBe(data);
      }),
      { numRuns: 100 },
    );
  });

  it('handles binary-like input without hanging', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 200 }), async (bytes) => {
        const stream = chunkedStream([bytes]);
        const events = await collectEvents(stream);
        expect(events).toBeInstanceOf(Array);
      }),
      { numRuns: 200 },
    );
  });
});
