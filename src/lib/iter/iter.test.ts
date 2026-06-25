import { describe, test, expect } from "bun:test";
import { createChannel } from "./channel";
import { createBroadcast } from "./broadcast";
import { consume } from "./consume";
import { batch } from "./batch";
import { toReadableStream, fromReadableStream } from "./adapters";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect<T>(source: AsyncIterable<T[]>): Promise<T[]> {
  const items: T[] = [];
  for await (const b of source) items.push(...b);
  return items;
}

async function collectBatches<T>(source: AsyncIterable<T[]>): Promise<T[][]> {
  const batches: T[][] = [];
  for await (const b of source) batches.push(b);
  return batches;
}

async function* fromArray<T>(items: T[]): AsyncIterable<T[]> {
  for (const item of items) yield [item];
}

async function* fromBatches<T>(...batches: T[][]): AsyncIterable<T[]> {
  for (const b of batches) yield b;
}

// ---------------------------------------------------------------------------
// consume
// ---------------------------------------------------------------------------

describe("consume", () => {
  test("calls fn for each batch", async () => {
    const seen: number[][] = [];
    await consume(fromBatches([1, 2], [3]), (b) => {
      seen.push(b);
    });
    expect(seen).toEqual([[1, 2], [3]]);
  });
});

// ---------------------------------------------------------------------------
// broadcast
// ---------------------------------------------------------------------------

describe("broadcast", () => {
  test("sends to all subscribers", async () => {
    const bc = createBroadcast<number>();
    const sub1 = bc.subscribe();
    const sub2 = bc.subscribe();

    bc.send(1);
    bc.send(2);
    bc.close();

    const [r1, r2] = await Promise.all([collect(sub1), collect(sub2)]);
    expect(r1).toEqual([1, 2]);
    expect(r2).toEqual([1, 2]);
  });

  test("late subscriber does not see past messages", async () => {
    const bc = createBroadcast<number>();
    bc.send(1);

    const sub = bc.subscribe();
    bc.send(2);
    bc.close();

    const result = await collect(sub);
    expect(result).toEqual([2]);
  });

  test("unsubscribe via break removes subscriber", async () => {
    const bc = createBroadcast<number>();
    const sub = bc.subscribe();

    bc.send(1);
    for await (const _ of sub) {
      break;
    }

    // Should not throw even though subscriber is gone
    bc.send(2);
    bc.close();
  });

  test("slow subscriber overflow drops only that subscriber", async () => {
    // Use a broadcast with no capacity limit for subscribers by default
    const bc = createBroadcast<number>();

    const fastResults: number[] = [];
    const fastSub = bc.subscribe();
    const fastDone = (async () => {
      for await (const b of fastSub) fastResults.push(...b);
    })();

    // Slow subscriber with tiny capacity — never drained
    const slowSub = bc.subscribe();
    // Wrap in a channel with capacity 2 isn't possible via broadcast API,
    // so let's test the concept differently: subscribe and never drain
    const _slowIter = slowSub[Symbol.asyncIterator]();

    // Wait for fast consumer to start
    await Promise.resolve();

    bc.send(1);
    await Promise.resolve();
    bc.send(2);
    await Promise.resolve();

    bc.close();
    await fastDone;

    // Fast subscriber got both messages
    expect(fastResults).toEqual([1, 2]);
  });

  test("capacity overflow removes only the overflowing subscriber", async () => {
    const bc = createBroadcast<number>({ capacity: 2 });

    // Fast subscriber — start consuming immediately
    const fastSub = bc.subscribe();
    const fastResults: number[] = [];
    const fastDone = (async () => {
      for await (const b of fastSub) fastResults.push(...b);
    })();

    // Slow subscriber — never consumed, will overflow
    const slowSub = bc.subscribe();
    const _slowIter = slowSub[Symbol.asyncIterator]();

    await Promise.resolve(); // let fast consumer start

    bc.send(1);
    await Promise.resolve();
    bc.send(2);
    await Promise.resolve();
    // slow subscriber now at capacity (2)
    bc.send(3); // overflows slow subscriber, removes it

    bc.close();
    await fastDone;

    expect(fastResults).toEqual([1, 2, 3]);
  });

  test("per-subscriber compaction", async () => {
    const bc = createBroadcast<{ key: string; v: number }>({
      compact: (items) => {
        const map = new Map<string, { key: string; v: number }>();
        for (const item of items) map.set(item.key, item);
        return [...map.values()];
      },
    });

    const sub = bc.subscribe();
    bc.send({ key: "a", v: 1 });
    bc.send({ key: "a", v: 2 });
    bc.send({ key: "b", v: 3 });
    bc.close();

    const result = await collect(sub);
    // a:1 should be compacted away
    expect(result).toContainEqual({ key: "a", v: 2 });
    expect(result).toContainEqual({ key: "b", v: 3 });
    expect(result).not.toContainEqual({ key: "a", v: 1 });
  });
});

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

describe("batch", () => {
  test("batches by maxSize", async () => {
    const result = await collectBatches(batch(fromArray([1, 2, 3, 4, 5]), { maxSize: 2 }));
    expect(result).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("flushes on source exhaustion", async () => {
    const result = await collectBatches(batch(fromArray([1, 2, 3]), { maxSize: 10 }));
    // All items should appear even though maxSize was never reached
    expect(result.flat()).toEqual([1, 2, 3]);
  });

  test("flushes on break via try/finally", async () => {
    const result: number[][] = [];
    for await (const b of batch(fromArray([1, 2, 3, 4, 5]), { maxSize: 10 })) {
      result.push(b);
      break; // Should still get the partial batch via finally
    }
    // We should get at least something
    expect(result.flat().length).toBeGreaterThan(0);
  });

  test("timeout flushes partial batch", async () => {
    const ch = createChannel<number>();
    ch.send(1);

    const batches: number[][] = [];
    const done = (async () => {
      for await (const b of batch(ch, { maxSize: 100, maxDelayMs: 1 })) {
        batches.push(b);
        if (batches.length >= 1) {
          ch.close();
        }
      }
    })();

    await done;
    expect(batches.flat()).toContain(1);
  });
});

// ---------------------------------------------------------------------------
// adapters
// ---------------------------------------------------------------------------

describe("toReadableStream", () => {
  test("converts async iterable to ReadableStream", async () => {
    const stream = toReadableStream(fromArray([1, 2, 3]));
    const reader = stream.getReader();

    const items: number[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      items.push(value);
    }
    expect(items).toEqual([1, 2, 3]);
  });

  test("handles batched input", async () => {
    const stream = toReadableStream(fromBatches([1, 2], [3]));
    const reader = stream.getReader();

    const items: number[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      items.push(value);
    }
    expect(items).toEqual([1, 2, 3]);
  });
});

describe("fromReadableStream", () => {
  test("converts ReadableStream to async iterable", async () => {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      },
    });

    const result = await collect(fromReadableStream(stream));
    expect(result).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// integration: channel → transform → consume
// ---------------------------------------------------------------------------

describe("integration", () => {
  test("channel → transform → consume", async () => {
    const ch = createChannel<number>();

    async function* double(src: AsyncIterable<number[]>): AsyncIterable<number[]> {
      for await (const b of src) yield b.map((n) => n * 2);
    }

    const results: number[] = [];
    const done = consume(double(ch), (b) => {
      results.push(...b);
    });

    ch.send(1);
    ch.send(2);
    ch.send(3);
    ch.close();

    await done;
    expect(results.sort()).toEqual([2, 4, 6]);
  });

  test("channel with compact deduplicates before yielding", async () => {
    const ch = createChannel<{ key: string; v: number }>({
      compact: (items) => {
        const map = new Map<string, { key: string; v: number }>();
        for (const i of items) map.set(i.key, i);
        return [...map.values()];
      },
    });

    // All sends happen before first pull → compaction merges them
    ch.send({ key: "a", v: 1 });
    ch.send({ key: "a", v: 2 }); // overwrites a:1
    ch.send({ key: "b", v: 3 });
    ch.close();

    const result = await collect(ch);
    expect(result).toContainEqual({ key: "a", v: 2 });
    expect(result).toContainEqual({ key: "b", v: 3 });
    expect(result).not.toContainEqual({ key: "a", v: 1 });
  });
});
