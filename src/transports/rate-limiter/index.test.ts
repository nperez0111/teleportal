import { describe, expect, it, mock, beforeEach } from "bun:test";
import { RateLimitedTransport } from "./index";
import type { RateLimitStorage, RateLimitState } from "../../storage/types";
import type { Message, ClientContext } from "teleportal";
import { createChannel } from "../../lib/iter";

// Mock Transport
const createMockTransport = () => {
  const ch = createChannel<Message<ClientContext>>();
  const writeFn = mock();
  return {
    source: ch as AsyncIterable<Message<ClientContext>[]>,
    write: writeFn as (message: Message<ClientContext>) => void,
    close() {},
    channel: ch,
  };
};

// Mock Storage
class MockRateLimitStorage implements RateLimitStorage {
  store = new Map<string, RateLimitState>();

  async getState(key: string) {
    return this.store.get(key) || null;
  }

  async setState(key: string, state: RateLimitState, _ttl: number) {
    this.store.set(key, state);
  }

  async deleteState(key: string) {
    this.store.delete(key);
  }

  async hasState(key: string) {
    return this.store.has(key);
  }

  async transaction<T>(key: string, cb: () => Promise<T>) {
    return cb();
  }
}

describe("RateLimitedTransport", () => {
  let transport: ReturnType<typeof createMockTransport>;
  let mockStorage: MockRateLimitStorage;

  beforeEach(() => {
    transport = createMockTransport();
    mockStorage = new MockRateLimitStorage();
  });

  /**
   * Push messages through the rate-limited INBOUND source (the only side
   * that is limited) and return the ones that survived.
   */
  async function pumpSource(
    rateLimited: { source: AsyncIterable<any[]> },
    channel: ReturnType<typeof createChannel<Message<ClientContext>>>,
    messages: any[],
  ): Promise<any[]> {
    const received: any[] = [];
    const readLoop = (async () => {
      for await (const batch of rateLimited.source) received.push(...batch);
    })();
    for (const msg of messages) channel.send(msg);
    channel.close();
    await readLoop;
    return received;
  }

  it("should enforce rate limits with transport tracking", async () => {
    const onRateLimitExceeded = mock();
    const rateLimited = new RateLimitedTransport(transport as any, {
      rules: [
        {
          id: "transport-limit",
          maxMessages: 2,
          windowMs: 1000,
          trackBy: "transport",
        },
      ],
      maxDelayMs: 0,
      onRateLimitExceeded,
    });

    // First 2 messages pass, 3rd is silently dropped (not thrown)
    const received = await pumpSource(rateLimited, transport.channel, [
      { type: "ping" },
      { type: "ping" },
      { type: "ping" },
    ]);

    expect(received.length).toBe(2);
    expect(onRateLimitExceeded).toHaveBeenCalled();
  });

  it("should use storage when provided", async () => {
    const rateLimited = new RateLimitedTransport<any, any>(transport as any, {
      rules: [
        {
          id: "user-limit",
          maxMessages: 2,
          windowMs: 1000,
          trackBy: "user",
          getUserId: (msg) => msg.context?.userId,
        },
      ],
      rateLimitStorage: mockStorage,
    });

    await pumpSource(rateLimited, transport.channel, [
      { type: "ping", context: { userId: "user1" } },
    ]);

    // Check storage - key now includes rule ID
    const state = await mockStorage.getState("rate-limit:user-limit:user:user1");
    expect(state).not.toBeNull();
    // Started with 2, consumed 1 -> 1 left
    expect(state?.tokens).toBe(1);
  });

  it("should separate limits for different users", async () => {
    const rateLimited = new RateLimitedTransport<any, any>(transport as any, {
      rules: [
        {
          id: "user-limit",
          maxMessages: 1,
          windowMs: 1000,
          trackBy: "user",
          getUserId: (msg) => msg.context?.userId,
        },
      ],
      rateLimitStorage: mockStorage,
    });

    // Each user consumes their own bucket independently
    const received = await pumpSource(rateLimited, transport.channel, [
      { type: "ping", context: { userId: "user1" } },
      { type: "ping", context: { userId: "user2" } },
    ]);
    expect(received.length).toBe(2);

    const state1 = await mockStorage.getState("rate-limit:user-limit:user:user1");
    expect(state1?.tokens).toBe(0);
    const state2 = await mockStorage.getState("rate-limit:user-limit:user:user2");
    expect(state2?.tokens).toBe(0);
  });

  it("should check permissions before rate limit", async () => {
    const checkPermission = mock((msg: any) => msg.context?.userId === "admin");
    const onPermissionDenied = mock();

    const rateLimited = new RateLimitedTransport(transport as any, {
      rules: [
        {
          id: "test-rule",
          maxMessages: 1,
          windowMs: 1000,
          trackBy: "transport",
        },
      ],
      checkPermission,
      onPermissionDenied,
    });

    // Non-admin: denied by permission check, rate limit is skipped so both
    // messages pass despite the limit of 1
    const received = await pumpSource(rateLimited, transport.channel, [
      { type: "ping", context: { userId: "guest" } },
      { type: "ping", context: { userId: "guest" } },
    ]);

    expect(received.length).toBe(2);
    expect(checkPermission).toHaveBeenCalled();
    expect(onPermissionDenied).toHaveBeenCalled();
  });

  it("should apply rate limit if permission granted", async () => {
    const onRateLimitExceeded = mock();
    const rateLimited = new RateLimitedTransport(transport as any, {
      rules: [
        {
          id: "test-rule",
          maxMessages: 1,
          windowMs: 1000,
          trackBy: "transport",
        },
      ],
      checkPermission: () => true, // Permission granted
      maxDelayMs: 0,
      onRateLimitExceeded,
    });

    // Second message should be silently dropped
    const received = await pumpSource(rateLimited, transport.channel, [
      { type: "ping" },
      { type: "ping" },
    ]);

    expect(received.length).toBe(1);
    expect(onRateLimitExceeded).toHaveBeenCalled();
  });

  it("should skip rate limit if shouldSkipRateLimit returns true", async () => {
    const onRateLimitExceeded = mock();
    const rateLimited = new RateLimitedTransport(transport as any, {
      rules: [
        {
          id: "test-rule",
          maxMessages: 1,
          windowMs: 1000,
          trackBy: "user",
          getUserId: (msg) => (msg.context as any)?.userId,
        },
      ],
      rateLimitStorage: mockStorage,
      shouldSkipRateLimit: (msg) => (msg.context as any)?.userId === "admin",
      maxDelayMs: 0,
      onRateLimitExceeded,
    });

    // Admin is never limited; regular user is limited after 1 message
    const received = await pumpSource(rateLimited, transport.channel, [
      { type: "ping", context: { userId: "admin" } },
      { type: "ping", context: { userId: "admin" } },
      { type: "ping", context: { userId: "admin" } },
      { type: "ping", context: { userId: "user" } },
      { type: "ping", context: { userId: "user" } },
    ]);

    expect(received.length).toBe(4);
    expect(onRateLimitExceeded).toHaveBeenCalledTimes(1);
  });

  it("should enforce multiple rules simultaneously", async () => {
    const rateLimited = new RateLimitedTransport<any, any>(transport as any, {
      rules: [
        {
          id: "user-limit",
          maxMessages: 100,
          windowMs: 1000, // 100 messages per second per user
          trackBy: "user",
          getUserId: (msg) => msg.context?.userId,
        },
        {
          id: "document-limit",
          maxMessages: 200,
          windowMs: 60000, // 200 messages per minute per document
          trackBy: "document",
          getDocumentId: (msg) => msg.document,
        },
      ],
      rateLimitStorage: mockStorage,
    });

    // First message should pass both rules
    await pumpSource(rateLimited, transport.channel, [
      { type: "ping", context: { userId: "user1" }, document: "doc1" },
    ]);

    // Check both rules have state
    const userState = await mockStorage.getState("rate-limit:user-limit:user:user1");
    const docState = await mockStorage.getState("rate-limit:document-limit:doc:doc1");
    expect(userState).not.toBeNull();
    expect(docState).not.toBeNull();
    expect(userState?.tokens).toBe(99); // 100 - 1
    expect(docState?.tokens).toBe(199); // 200 - 1
  });

  it("reports resetAt as time-to-next-token, not time-to-full-window", async () => {
    // Regression: resetAt used to be `lastRefill + windowMs` — when the next
    // token would make the bucket FULL again. A retransmit only needs one
    // token, which refills in windowMs / maxMessages. Overestimating by up to
    // the whole window made nacked clients wait seconds (10s for the default
    // per-document rule) instead of milliseconds, which the user sees as a
    // multi-second ack stall that only resolves after they stop typing.
    const exceededEvents: any[] = [];
    const rateLimited = new RateLimitedTransport<any, any>(transport as any, {
      rules: [
        {
          id: "user-limit",
          maxMessages: 100,
          windowMs: 10_000, // one token refills every 100ms
          trackBy: "user",
          getUserId: (msg) => msg.context?.userId,
        },
      ],
      rateLimitStorage: mockStorage,
      maxDelayMs: 0,
      onRateLimitExceeded: (data) => exceededEvents.push(data),
    });

    const before = Date.now();
    const messages = Array.from({ length: 101 }, () => ({
      type: "ping",
      context: { userId: "masher" },
    }));
    const received = await pumpSource(rateLimited, transport.channel, messages);

    expect(received.length).toBe(100);
    expect(exceededEvents.length).toBe(1);
    const waitMs = exceededEvents[0].resetAt - before;
    // One token refills in 100ms; allow slack for test runtime, but the old
    // computation would report ~10_000ms.
    expect(waitMs).toBeGreaterThanOrEqual(0);
    expect(waitMs).toBeLessThan(1000);
  });

  it("reports resetAt as time-to-next-token for transport-tracked rules too", async () => {
    const exceededEvents: any[] = [];
    const rateLimited = new RateLimitedTransport(transport as any, {
      rules: [
        {
          id: "transport-limit",
          maxMessages: 100,
          windowMs: 10_000,
          trackBy: "transport",
        },
      ],
      maxDelayMs: 0,
      onRateLimitExceeded: (data) => exceededEvents.push(data),
    });

    const before = Date.now();
    const messages = Array.from({ length: 101 }, () => ({ type: "ping" }));
    await pumpSource(rateLimited, transport.channel, messages);

    expect(exceededEvents.length).toBe(1);
    const waitMs = exceededEvents[0].resetAt - before;
    expect(waitMs).toBeGreaterThanOrEqual(0);
    expect(waitMs).toBeLessThan(1000);
  });

  it("never rate limits outbound writes (server→client must be lossless)", async () => {
    // Regression: outbound broadcasts used to consume the same token buckets
    // as inbound messages and were silently dropped when exhausted. A dropped
    // doc-update broadcast permanently diverges the receiving client — Y.js
    // parks every causally-later update on the missing dependency until a
    // full state-vector resync.
    const onRateLimitExceeded = mock();
    const rateLimited = new RateLimitedTransport<any, any>(transport as any, {
      rules: [
        {
          id: "user-limit",
          maxMessages: 1,
          windowMs: 60_000,
          trackBy: "user",
          getUserId: (msg) => msg.context?.userId,
        },
      ],
      rateLimitStorage: mockStorage,
      onRateLimitExceeded,
    });

    // Exhaust user1's bucket through the inbound source path
    const received: any[] = [];
    const readLoop = (async () => {
      for await (const batch of rateLimited.source) received.push(...batch);
    })();
    transport.channel.send({ type: "doc", context: { userId: "user1" } } as any);
    transport.channel.send({ type: "doc", context: { userId: "user1" } } as any);
    transport.channel.close();
    await readLoop;
    expect(received.length).toBe(1);
    expect(onRateLimitExceeded).toHaveBeenCalledTimes(1);

    // Outbound writes for the same exhausted user must all be delivered
    for (let i = 0; i < 5; i++) {
      await rateLimited.write({ type: "doc", context: { userId: "user1" } } as any);
    }
    expect(transport.write).toHaveBeenCalledTimes(5);
    // ...without recording new exceedances or consuming tokens
    expect(onRateLimitExceeded).toHaveBeenCalledTimes(1);
  });

  it("nacks oversized inbound messages without killing the stream", async () => {
    // Regression: the source transform used to throw on oversized messages,
    // which tore down the server's per-client consume loop — the connection
    // then stopped acking and broadcasting while the socket stayed open.
    const onMessageSizeExceeded = mock();
    const written: any[] = [];
    const ch = createChannel<Message<ClientContext>>();
    const rateLimited = new RateLimitedTransport(
      {
        source: ch as AsyncIterable<Message<ClientContext>[]>,
        write(msg: any) {
          written.push(msg);
        },
        close() {},
      } as any,
      {
        rules: [{ id: "r", maxMessages: 100, windowMs: 1000, trackBy: "transport" }],
        maxMessageSize: 10,
        onMessageSizeExceeded,
      },
    );

    const received: any[] = [];
    const readLoop = (async () => {
      for await (const batch of rateLimited.source) received.push(...batch);
    })();

    ch.send({ type: "doc", id: "big-message", encoded: new Uint8Array(100) } as any);
    ch.send({ type: "doc", id: "small-message", encoded: new Uint8Array(4) } as any);
    ch.close();
    await readLoop;
    // The nack write is fire-and-forget; let the microtask settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received.length).toBe(1);
    expect(onMessageSizeExceeded).toHaveBeenCalledTimes(1);

    // The sender gets a permanent nack naming the rejected message and why,
    // so it stops waiting for an ack instead of retransmitting.
    expect(written.length).toBe(1);
    expect(written[0].type).toBe("ack");
    expect(written[0].payload.messageId).toBe("big-message");
    expect(written[0].payload.retryAfter).toBeUndefined();
    expect(written[0].payload.error).toContain("message-too-large");
  });

  it("delays rate-limited messages instead of dropping them (flow control)", async () => {
    // The whole point of the limiter is to SLOW a client down, not to lose
    // its messages: a dropped doc update engages the NACK/retransmit path,
    // and the retransmit races the client's fresh sends for every refilled
    // token while the server parks all causally-later updates on the missing
    // one — peers see nothing until the client stops typing. Holding the
    // message until the next token refills delivers everything, in order,
    // at the allowed rate.
    const onRateLimitExceeded = mock();
    const delayEvents: any[] = [];
    const rateLimited = new RateLimitedTransport(transport as any, {
      rules: [
        {
          id: "transport-limit",
          maxMessages: 2,
          windowMs: 100, // one token refills every 50ms
          trackBy: "transport",
        },
      ],
      maxDelayMs: 1000,
      onRateLimitExceeded,
      onRateLimitDelay: (details) => delayEvents.push(details),
    });

    const start = Date.now();
    const received = await pumpSource(rateLimited, transport.channel, [
      { type: "ping" },
      { type: "ping" },
      { type: "ping" },
      { type: "ping" },
    ]);
    const elapsed = Date.now() - start;

    // All four delivered — two immediately, two throttled to the refill rate.
    expect(received.length).toBe(4);
    expect(elapsed).toBeGreaterThanOrEqual(90);
    // Delayed-then-delivered is not an exceedance.
    expect(onRateLimitExceeded).not.toHaveBeenCalled();
    // ...but it IS observable: one delay event per held message.
    expect(delayEvents.length).toBe(2);
    expect(delayEvents[0].ruleId).toBe("transport-limit");
    expect(delayEvents[0].delayMs).toBeGreaterThan(0);
  });

  it("drops and reports when the required wait exceeds maxDelayMs", async () => {
    const onRateLimitExceeded = mock();
    const rateLimited = new RateLimitedTransport(transport as any, {
      rules: [
        {
          id: "transport-limit",
          maxMessages: 1,
          windowMs: 10_000, // next token is 10s away — far past the budget
          trackBy: "transport",
        },
      ],
      maxDelayMs: 5,
      onRateLimitExceeded,
    });

    const received = await pumpSource(rateLimited, transport.channel, [
      { type: "ping" },
      { type: "ping" },
    ]);

    expect(received.length).toBe(1);
    expect(onRateLimitExceeded).toHaveBeenCalledTimes(1);
  });

  it("refunds tokens consumed by earlier rules when a later rule rejects", async () => {
    // Regression: a message that passed rule A but failed rule B still burned
    // A's token. Every retransmit of that message re-burned A's budget, so a
    // client stuck on a hot document also drained its per-user budget — retry
    // amplification that spread one rule's contention to all rules.
    const rateLimited = new RateLimitedTransport<any, any>(transport as any, {
      rules: [
        {
          id: "user-limit",
          maxMessages: 5,
          windowMs: 10_000,
          trackBy: "user",
          getUserId: (msg) => msg.context?.userId,
        },
        {
          id: "doc-limit",
          maxMessages: 1,
          windowMs: 10_000,
          trackBy: "document",
          getDocumentId: (msg) => msg.document,
        },
      ],
      rateLimitStorage: mockStorage,
      maxDelayMs: 0,
    });

    // Message 1 passes both rules. Messages 2 and 3 pass user-limit but fail
    // doc-limit — the user-limit token they consumed must be handed back.
    const received = await pumpSource(rateLimited, transport.channel, [
      { type: "ping", context: { userId: "user1" }, document: "doc1" },
      { type: "ping", context: { userId: "user1" }, document: "doc1" },
      { type: "ping", context: { userId: "user1" }, document: "doc1" },
    ]);

    expect(received.length).toBe(1);
    const userState = await mockStorage.getState("rate-limit:user-limit:user:user1");
    // Only the delivered message holds a user token: 5 - 1 = 4 (plus a hair
    // of refill). Without the refund this would be 2.
    expect(userState?.tokens).toBeGreaterThanOrEqual(4);
    expect(userState?.tokens).toBeLessThan(4.1);
  });

  it("enforces user-tracked rules in-memory when no storage is configured", async () => {
    // Regression: trackBy "user"/"document" rules without a RateLimitStorage
    // were silently skipped — the documented in-memory fallback didn't exist,
    // so a server configured without shared storage had NO rate limiting.
    const onRateLimitExceeded = mock();
    const rateLimited = new RateLimitedTransport(transport as any, {
      rules: [
        {
          id: "user-limit",
          maxMessages: 1,
          windowMs: 10_000,
          trackBy: "user",
          getUserId: (msg: any) => msg.context?.userId,
        },
      ],
      maxDelayMs: 0,
      onRateLimitExceeded,
    });

    const received = await pumpSource(rateLimited, transport.channel, [
      { type: "ping", context: { userId: "user1" } },
      { type: "ping", context: { userId: "user1" } }, // over user1's limit
      { type: "ping", context: { userId: "user2" } }, // separate bucket
    ]);

    expect(received.length).toBe(2);
    expect(onRateLimitExceeded).toHaveBeenCalledTimes(1);
  });

  it("keeps awareness/presence chatter out of the sync budgets (default rules)", async () => {
    // Regression: awareness updates fire per keystroke UNBATCHED, so a fast
    // typist emits dozens/sec. Counting them against sync-per-document let
    // cursor chatter drain the budget doc updates need — sustained typing
    // stalled content propagation after the bucket ran dry (~20s).
    const { defaultRateLimitRules } = await import("./index");
    const onRateLimitExceeded = mock();
    const rateLimited = new RateLimitedTransport<any, any>(transport as any, {
      rules: defaultRateLimitRules().map((r) =>
        // Shrink budgets so the test is fast: sync 2/window, awareness 3/window.
        r.id === "sync-per-user" || r.id === "sync-per-document"
          ? { ...r, maxMessages: 2, windowMs: 60_000 }
          : { ...r, maxMessages: 3, windowMs: 60_000 },
      ),
      rateLimitStorage: mockStorage,
      maxDelayMs: 0,
      onRateLimitExceeded,
    });

    const ctx = { userId: "typist" };
    const received = await pumpSource(rateLimited, transport.channel, [
      // 3 awareness messages: must NOT consume sync tokens.
      { type: "awareness", context: ctx, document: "doc1" },
      { type: "awareness", context: ctx, document: "doc1" },
      { type: "presence", context: ctx, document: "doc1" },
      // 2 doc updates: exactly the sync budget — all pass.
      { type: "doc", context: ctx, document: "doc1" },
      { type: "doc", context: ctx, document: "doc1" },
      // 4th awareness message exceeds the awareness budget — dropped alone.
      { type: "awareness", context: ctx, document: "doc1" },
    ]);

    expect(received.length).toBe(5);
    expect(onRateLimitExceeded).toHaveBeenCalledTimes(1);
    expect(onRateLimitExceeded.mock.calls[0][0].ruleId).toBe("awareness-per-user");
  });

  it("should drop rate-limited messages on readable stream too", async () => {
    const onRateLimitExceeded = mock();
    const ch = createChannel<Message<ClientContext>>();

    const rateLimited = new RateLimitedTransport(
      { source: ch as AsyncIterable<Message<ClientContext>[]>, write() {}, close() {} } as any,
      {
        rules: [
          {
            id: "transport-limit",
            maxMessages: 1,
            windowMs: 1000,
            trackBy: "transport",
          },
        ],
        maxDelayMs: 0,
        onRateLimitExceeded,
      },
    );

    const received: any[] = [];

    // Start reading in background
    const readLoop = (async () => {
      for await (const batch of rateLimited.source) {
        for (const msg of batch) {
          received.push(msg);
        }
      }
    })();

    // Enqueue 3 messages into source
    ch.send({ type: "ping" } as any);
    ch.send({ type: "ping" } as any);
    ch.send({ type: "ping" } as any);

    // Close the source and wait for the read loop to drain deterministically
    ch.close();
    await readLoop;

    // Only the first should have passed through
    expect(received.length).toBe(1);
    expect(onRateLimitExceeded).toHaveBeenCalledTimes(2);
  });
});
