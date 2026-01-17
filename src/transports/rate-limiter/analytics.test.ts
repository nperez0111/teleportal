import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Server } from "../../server/server";
import { createInMemory } from "../../storage/in-memory";
import { noopTransport } from "../passthrough";
import { withRateLimit } from "./index";
import { DocMessage } from "teleportal";
import type { Message, ServerContext, StateVector } from "teleportal";
import type { RateLimitStorage, RateLimitState } from "../../storage/types";

// Mock Transport that allows enqueueing messages for testing
class MockTransport<Context extends ServerContext> {
  public readable: ReadableStream<Message<Context>>;
  public writable: WritableStream<Message<Context>>;
  private controller: ReadableStreamDefaultController<Message<Context>> | null =
    null;

  constructor() {
    const self = this;
    this.readable = new ReadableStream<Message<Context>>({
      start(controller) {
        self.controller = controller;
      },
    });
    this.writable = new WritableStream<Message<Context>>();
  }

  // Helper to enqueue messages for testing
  enqueueMessage(message: Message<Context>) {
    if (this.controller) {
      this.controller.enqueue(message);
    }
  }

  closeReadable() {
    if (this.controller) {
      this.controller.close();
    }
  }
}

// Mock RateLimitStorage for testing
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

describe("Rate Limit Analytics", () => {
  let server: Server<any>;

  beforeEach(() => {
    // Create server with minimal config
    const storage = createInMemory();
    server = new Server({
      getStorage: async () => storage.documentStorage,
    });
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
  });

  it("should report rate limit metrics in getStatus", async () => {
    // 1. Setup a transport with aggressive rate limits and storage
    const baseTransport = new MockTransport<any>();
    const rateLimitStorage = new MockRateLimitStorage();
    const rateLimitedTransport = withRateLimit(baseTransport as any, {
      rules: [
        {
          id: "test-rule",
          maxMessages: 1, // Only 1 message allowed
          windowMs: 1000,
          trackBy: "transport", // Use transport-level tracking
        },
      ],
      metricsCollector: server.getMetricsCollector(), // Use server's metrics collector
      rateLimitStorage, // Use storage for proper tracking
    });

    // 2. Create client with rate-limited transport
    server.createClient({
      transport: rateLimitedTransport,
      id: "test-client",
    });

    // 3. Send first message through the writable stream (should pass rate limit)
    const message1 = new DocMessage(
      "test-doc",
      { type: "sync-step-1", sv: new Uint8Array() as StateVector },
      { clientId: "test-client", userId: "user-1" },
      false,
    );

    const writer = rateLimitedTransport.writable.getWriter();
    await writer.write(message1);
    writer.releaseLock();

    // Wait for message to be processed
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 4. Send second message (should be rate limited)
    const message2 = new DocMessage(
      "test-doc",
      { type: "sync-step-1", sv: new Uint8Array() as StateVector },
      { clientId: "test-client", userId: "user-1" },
      false,
    );

    const writer2 = rateLimitedTransport.writable.getWriter();
    
    // First message consumed the token, so second should be rate limited
    try {
      await writer2.write(message2);
      // If we get here without error, something is wrong
      expect(false).toBe(true);
    } catch (error: any) {
      // Expected: rate limit exceeded
      expect(error.message).toBe("Rate limit exceeded");
    }

    writer2.releaseLock();

    // Wait for metrics to be recorded
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 5. Check status - should show rate limit metrics
    const status = await server.getStatus();

    // Verify rate limit metrics are reported
    expect(status.rateLimitExceededTotal).toBeGreaterThan(0);
    expect(status.rateLimitBreakdown).toBeDefined();
    expect(status.rateLimitTopOffenders).toBeDefined();
    expect(status.rateLimitRecentEvents).toBeDefined();

    // Verify breakdown includes transport tracking
    expect(status.rateLimitBreakdown).toBeDefined();
    expect(status.rateLimitBreakdown!["transport"]).toBeGreaterThan(0);

    // Verify recent events contain the rate limit event
    expect(status.rateLimitRecentEvents).toBeDefined();
    expect(status.rateLimitRecentEvents!.length).toBeGreaterThan(0);
    const recentEvent = status.rateLimitRecentEvents![0];
    expect(recentEvent).toBeDefined();
    expect(recentEvent.trackBy).toBe("transport");

    // Clean up
    baseTransport.closeReadable();
  });
});
