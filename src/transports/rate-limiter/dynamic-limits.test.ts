import { describe, expect, it, mock, beforeEach } from "bun:test";
import { RateLimitedTransport } from "./index";
import type { RateLimitStorage, RateLimitState } from "../../storage/types";
import type { Message, ClientContext } from "teleportal";

// Mock Transport
const createMockTransport = () => {
  const readable = new ReadableStream<Message<ClientContext>>({
    start(controller) {
      // @ts-ignore
      this.controller = controller;
    },
  });
  const writable = new WritableStream<Message<ClientContext>>({
    write: mock(),
  });
  return { readable, writable, controller: (readable as any).controller };
};

// Mock Storage
class MockRateLimitStorage implements RateLimitStorage {
  store = new Map<string, RateLimitState>();

  async getState(key: string) {
    return this.store.get(key) || null;
  }

  async setState(key: string, state: RateLimitState, ttl: number) {
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

  it("should support dynamic maxMessages based on user", async () => {
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
    });

    const writer = rateLimited.writable.getWriter();

    // Normal user: limit 2. Write 2 messages.
    await writer.write({ type: "ping", context: { userId: "normal" } } as any);
    await writer.write({ type: "ping", context: { userId: "normal" } } as any);

    // VIP user: limit 10. Write 5 messages.
    for (let i = 0; i < 5; i++) {
      await writer.write({ type: "ping", context: { userId: "vip" } } as any);
    }

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

    // Now send 3rd message for Normal - should fail
    let errorNormal;
    try {
      await writer.write({
        type: "ping",
        context: { userId: "normal" },
      } as any);
    } catch (e: any) {
      errorNormal = e;
    }
    expect(errorNormal).toBeDefined();
    expect(errorNormal.message).toBe("Rate limit exceeded");
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

    const writer = rateLimited.writable.getWriter();

    await writer.write({ type: "ping", context: { userId: "slow" } } as any);

    const stateSlow = await mockStorage.getState("rate-limit:user-limit:user:slow");
    expect(stateSlow?.windowMs).toBe(10000);

    await writer.write({ type: "ping", context: { userId: "fast" } } as any);

    const stateFast = await mockStorage.getState("rate-limit:user-limit:user:fast");
    expect(stateFast?.windowMs).toBe(1000);
  });
});
