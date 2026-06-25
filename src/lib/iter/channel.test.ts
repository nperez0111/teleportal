import { describe, test, expect } from "bun:test";
import { createChannel } from "./channel";

describe("Channel", () => {
  test("drains all buffered items as one batch", async () => {
    const ch = createChannel<number>();
    ch.send(1);
    ch.send(2);
    ch.send(3);
    ch.close();

    const batches: number[][] = [];
    for await (const batch of ch) {
      batches.push(batch);
    }
    expect(batches).toEqual([[1, 2, 3]]);
  });

  test("yields multiple batches when consumer is fast", async () => {
    const ch = createChannel<number>();

    const batches: number[][] = [];
    const done = (async () => {
      for await (const batch of ch) {
        batches.push(batch);
      }
    })();

    // Wait for the consumer to start waiting
    await Promise.resolve();

    ch.send(1);
    await Promise.resolve();

    ch.send(2);
    await Promise.resolve();

    ch.close();
    await done;

    // Each send wakes the consumer individually → separate batches
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches.flat()).toEqual([1, 2]);
  });

  test("coalesces items when consumer is slower than producer", async () => {
    const ch = createChannel<number>();

    const batches: number[][] = [];
    const done = (async () => {
      for await (const batch of ch) {
        batches.push(batch);
        // Simulate slow consumer
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    // Wait for consumer to enter first wait
    await Promise.resolve();

    // Burst of sends while consumer is busy
    ch.send(1);
    await Promise.resolve();

    // Wait for consumer to start processing first batch, then burst more
    await new Promise((r) => setTimeout(r, 0));
    ch.send(2);
    ch.send(3);
    ch.send(4);

    ch.close();
    await done;

    // The burst should coalesce into fewer batches
    expect(batches.flat()).toEqual([1, 2, 3, 4]);
    expect(batches.length).toBeLessThan(4);
  });

  test("applies compact at drain time", async () => {
    const ch = createChannel<{ key: string; value: number }>({
      compact: (items) => {
        // Keep only the latest per key
        const map = new Map<string, { key: string; value: number }>();
        for (const item of items) {
          map.set(item.key, item);
        }
        return [...map.values()];
      },
    });

    ch.send({ key: "a", value: 1 });
    ch.send({ key: "b", value: 2 });
    ch.send({ key: "a", value: 3 }); // overwrites a:1
    ch.close();

    const batches: { key: string; value: number }[][] = [];
    for await (const batch of ch) {
      batches.push(batch);
    }
    expect(batches.length).toBe(1);
    expect(batches[0]).toContainEqual({ key: "a", value: 3 });
    expect(batches[0]).toContainEqual({ key: "b", value: 2 });
    expect(batches[0]).not.toContainEqual({ key: "a", value: 1 }); // overwritten
  });

  test("throws on send after close", () => {
    const ch = createChannel<number>();
    ch.close();
    expect(() => ch.send(1)).toThrow("Channel is closed");
  });

  test("throws on send when over capacity", () => {
    const ch = createChannel<number>({ capacity: 2 });
    ch.send(1);
    ch.send(2);
    expect(() => ch.send(3)).toThrow("Channel buffer overflow");
  });

  test("error causes next pull to reject", async () => {
    const ch = createChannel<number>();
    ch.send(1);
    ch.error(new Error("boom"));

    const iter = ch[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow("boom");
  });

  test("error while consumer is waiting rejects the pending pull", async () => {
    const ch = createChannel<number>();

    const result = (async () => {
      const batches: number[][] = [];
      for await (const batch of ch) {
        batches.push(batch);
      }
      return batches;
    })();

    await Promise.resolve();
    ch.error(new Error("connection lost"));

    await expect(result).rejects.toThrow("connection lost");
  });

  test("close with no items ends iteration immediately", async () => {
    const ch = createChannel<number>();
    ch.close();

    const batches: number[][] = [];
    for await (const batch of ch) {
      batches.push(batch);
    }
    expect(batches).toEqual([]);
  });

  test("close flushes pending items as final batch", async () => {
    const ch = createChannel<number>();
    ch.send(1);
    ch.send(2);
    ch.close();

    const batches: number[][] = [];
    for await (const batch of ch) {
      batches.push(batch);
    }
    expect(batches).toEqual([[1, 2]]);
  });

  test("breaking out of for-await cleans up", async () => {
    const ch = createChannel<number>();

    const batches: number[][] = [];
    ch.send(1);
    ch.send(2);

    for await (const batch of ch) {
      batches.push(batch);
      break;
    }

    expect(batches).toEqual([[1, 2]]);
    // Channel should be closed after break triggers return()
    expect(() => ch.send(3)).toThrow("Channel is closed");
  });

  test("only allows a single consumer", () => {
    const ch = createChannel<number>();
    ch[Symbol.asyncIterator]();
    expect(() => ch[Symbol.asyncIterator]()).toThrow("single consumer");
  });

  test("compact is not called when buffer is empty at close", async () => {
    let compactCalled = false;
    const ch = createChannel<number>({
      compact: (items) => {
        compactCalled = true;
        return items;
      },
    });
    ch.close();

    for await (const _ of ch) {
      // should not enter
    }
    expect(compactCalled).toBe(false);
  });

  test("capacity is checked before compact", async () => {
    const ch = createChannel<number>({
      capacity: 3,
      compact: (items) => [items.reduce((a, b) => a + b, 0)],
    });

    ch.send(1);
    ch.send(2);
    ch.send(3);
    // Capacity is 3, buffer has 3 items — even though compact would reduce to 1
    expect(() => ch.send(4)).toThrow("Channel buffer overflow");

    // Drain triggers compact
    const iter = ch[Symbol.asyncIterator]();
    const { value } = await iter.next();
    expect(value).toEqual([6]); // 1+2+3

    // Now we can send again
    ch.send(4);
    ch.close();
    const { value: v2 } = await iter.next();
    expect(v2).toEqual([4]);
  });
});
