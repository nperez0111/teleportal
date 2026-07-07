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

describe("RateLimitedTransport - Dynamic Limits", () => {
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

  it("should support dynamic maxMessages based on user", async () => {
    const onRateLimitExceeded = mock();
    const rateLimited = new RateLimitedTransport<any, any>(transport as any, {
      rules: [
        {
          id: "user-limit",
          // VIP user gets 10, others get 2
          maxMessages: (msg) => (msg.context?.userId === "vip" ? 10 : 2),
          windowMs: 1000,
          trackBy: "user",
          getUserId: (msg) => msg.context?.userId,
        },
      ],
      rateLimitStorage: mockStorage,
      maxDelayMs: 0,
      onRateLimitExceeded,
    });

    // Normal user: limit 2, sends 3 (last dropped). VIP: limit 10, sends 5.
    const received = await pumpSource(rateLimited, transport.channel, [
      { type: "ping", context: { userId: "normal" } },
      { type: "ping", context: { userId: "normal" } },
      { type: "ping", context: { userId: "vip" } },
      { type: "ping", context: { userId: "vip" } },
      { type: "ping", context: { userId: "vip" } },
      { type: "ping", context: { userId: "vip" } },
      { type: "ping", context: { userId: "vip" } },
      { type: "ping", context: { userId: "normal" } },
    ]);

    expect(received.length).toBe(7);
    expect(onRateLimitExceeded).toHaveBeenCalled();

    // Check storage for VIP - key includes rule ID
    const stateVip = await mockStorage.getState("rate-limit:user-limit:user:vip");
    expect(stateVip).not.toBeNull();
    expect(stateVip?.maxMessages).toBe(10);
    // consumed 5, so tokens should be 5 (with possible tiny refill due to timing)
    expect(stateVip?.tokens).toBeGreaterThanOrEqual(5);
    expect(stateVip?.tokens).toBeLessThan(5.1);

    // Check storage for Normal
    const stateNormal = await mockStorage.getState("rate-limit:user-limit:user:normal");
    expect(stateNormal?.maxMessages).toBe(2);
    // Due to token bucket refill, tokens might be slightly > 0, but should be < 1
    expect(stateNormal?.tokens).toBeLessThan(1); // 2 - 2 = 0 (with possible tiny refill)
  });

  it("should support dynamic windowMs", async () => {
    const rateLimited = new RateLimitedTransport<any, any>(transport as any, {
      rules: [
        {
          id: "user-limit",
          maxMessages: 5,
          // Slow user has 10s window, fast user has 1s window
          windowMs: (msg) => (msg.context?.userId === "slow" ? 10000 : 1000),
          trackBy: "user",
          getUserId: (msg) => msg.context?.userId,
        },
      ],
      rateLimitStorage: mockStorage,
    });

    await pumpSource(rateLimited, transport.channel, [
      { type: "ping", context: { userId: "slow" } },
      { type: "ping", context: { userId: "fast" } },
    ]);

    const stateSlow = await mockStorage.getState("rate-limit:user-limit:user:slow");
    expect(stateSlow?.windowMs).toBe(10000);

    const stateFast = await mockStorage.getState("rate-limit:user-limit:user:fast");
    expect(stateFast?.windowMs).toBe(1000);
  });
});
