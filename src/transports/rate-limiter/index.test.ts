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

describe("RateLimitedTransport", () => {
  let transport: ReturnType<typeof createMockTransport>;
  let mockStorage: MockRateLimitStorage;

  beforeEach(() => {
    transport = createMockTransport();
    mockStorage = new MockRateLimitStorage();
  });

  it("should enforce rate limits with transport tracking", async () => {
    const rateLimited = new RateLimitedTransport(transport as any, {
      rules: [
        {
          id: "transport-limit",
          maxMessages: 2,
          windowMs: 1000,
          trackBy: "transport",
        },
      ],
    });

    const writer = rateLimited.writable.getWriter();

    // First 2 messages should pass
    await writer.write({ type: "ping" } as any);
    await writer.write({ type: "ping" } as any);

    // 3rd message should fail
    let error;
    try {
      await writer.write({ type: "ping" } as any);
    } catch (e: any) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toBe("Rate limit exceeded");
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

    const writer = rateLimited.writable.getWriter();
    const msg = { type: "ping", context: { userId: "user1" } } as any;

    await writer.write(msg);

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

    const writer = rateLimited.writable.getWriter();

    // User 1 uses their limit
    await writer.write({ type: "ping", context: { userId: "user1" } } as any);

    // Check User 1 state
    const state1 = await mockStorage.getState("rate-limit:user-limit:user:user1");
    expect(state1?.tokens).toBe(0);

    // User 2 should not have state yet
    const state2 = await mockStorage.getState("rate-limit:user-limit:user:user2");
    expect(state2).toBeNull();

    // If we write for User 2, it should work (and create state)
    // Note: We can't use the same writer if it crashed, but here we haven't crashed it yet.
    await writer.write({ type: "ping", context: { userId: "user2" } } as any);

    const state2After = await mockStorage.getState("rate-limit:user-limit:user:user2");
    expect(state2After?.tokens).toBe(0);
  });

  it("should check permissions before rate limit", async () => {
    const checkPermission = mock((msg) => msg.context?.userId === "admin");
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

    const writer = rateLimited.writable.getWriter();

    // Non-admin: denied by permission check, should skip rate limit
    await writer.write({ type: "ping", context: { userId: "guest" } } as any);
    expect(checkPermission).toHaveBeenCalled();
    expect(onPermissionDenied).toHaveBeenCalled();

    // Verify rate limit was skipped (multiple messages pass despite limit 1)
    await writer.write({ type: "ping", context: { userId: "guest" } } as any);
  });

  it("should apply rate limit if permission granted", async () => {
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
    });

    const writer = rateLimited.writable.getWriter();

    await writer.write({ type: "ping" } as any);

    // Second should fail
    let error;
    try {
      await writer.write({ type: "ping" } as any);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
  });

  it("should skip rate limit if shouldSkipRateLimit returns true", async () => {
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
      shouldSkipRateLimit: (msg) => (msg.context as any)?.userId === "admin",
    });

    const writer = rateLimited.writable.getWriter();

    // Admin should not be limited
    await writer.write({ type: "ping", context: { userId: "admin" } } as any);
    await writer.write({ type: "ping", context: { userId: "admin" } } as any);
    await writer.write({ type: "ping", context: { userId: "admin" } } as any);

    // Regular user should be limited
    await writer.write({ type: "ping", context: { userId: "user" } } as any);
    try {
      await writer.write({ type: "ping", context: { userId: "user" } } as any);
    } catch (e: any) {
      expect(e.message).toBe("Rate limit exceeded");
    }
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

    const writer = rateLimited.writable.getWriter();
    const msg = {
      type: "ping",
      context: { userId: "user1" },
      document: "doc1",
    } as any;

    // First message should pass both rules
    await writer.write(msg);

    // Check both rules have state
    const userState = await mockStorage.getState(
      "rate-limit:user-limit:user:user1",
    );
    const docState = await mockStorage.getState(
      "rate-limit:document-limit:doc:doc1",
    );
    expect(userState).not.toBeNull();
    expect(docState).not.toBeNull();
    expect(userState?.tokens).toBe(99); // 100 - 1
    expect(docState?.tokens).toBe(199); // 200 - 1
  });
});
