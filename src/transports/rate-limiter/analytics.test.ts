import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Server } from "../../server/server";
import { MemoryDocumentStorage } from "../../storage/in-memory/document-storage";
import { withRateLimit } from "./index";
import { DocMessage } from "teleportal";
import type { Message, ServerContext, StateVector, Transport } from "teleportal";
import type { RateLimitStorage, RateLimitState } from "../../storage/types";
import { createChannel } from "../../lib/iter";

function createMockTransport<Context extends ServerContext>(): Transport<Context> & {
  enqueueMessage(message: Message<Context>): void;
  closeSource(): void;
} {
  const channel = createChannel<Message<Context>>();
  return {
    source: channel,
    write() {},
    close() {
      channel.close();
    },
    enqueueMessage(message: Message<Context>) {
      channel.send(message);
    },
    closeSource() {
      channel.close();
    },
  };
}

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

describe("Rate Limit Analytics", () => {
  let server: Server<any>;

  beforeEach(() => {
    const documentStorage = new MemoryDocumentStorage();
    server = new Server({
      storage: async () => documentStorage,
    });
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
  });

  it("should report rate limit metrics in getStatus", async () => {
    const baseTransport = createMockTransport<any>();
    const rateLimitStorage = new MockRateLimitStorage();
    const rateLimitedTransport = withRateLimit(baseTransport, {
      rules: [
        {
          id: "test-rule",
          maxMessages: 1,
          windowMs: 1000,
          trackBy: "transport",
        },
      ],
      metricsCollector: server.getMetricsCollector(),
      rateLimitStorage,
      maxDelayMs: 0,
    });

    server.createClient({
      transport: rateLimitedTransport,
      id: "test-client",
    });

    const message1 = new DocMessage(
      "test-doc",
      { type: "sync-step-1", sv: new Uint8Array([0]) as StateVector },
      { clientId: "test-client", userId: "user-1" },
      false,
    );

    baseTransport.enqueueMessage(message1);

    await new Promise((resolve) => setTimeout(resolve, 1));

    const message2 = new DocMessage(
      "test-doc",
      { type: "sync-step-1", sv: new Uint8Array([0]) as StateVector },
      { clientId: "test-client", userId: "user-1" },
      false,
    );

    // Inbound source is the rate-limited side; the second message exceeds the
    // 1-message transport bucket and is dropped, recording the metric.
    baseTransport.enqueueMessage(message2);

    await new Promise((resolve) => setTimeout(resolve, 1));

    const status = await server.getStatus();

    expect(status.rateLimitExceededTotal).toBeGreaterThan(0);
    expect(status.rateLimitBreakdown).toBeDefined();
    expect(status.rateLimitTopOffenders).toBeDefined();
    expect(status.rateLimitRecentEvents).toBeDefined();

    expect(status.rateLimitBreakdown).toBeDefined();
    expect(status.rateLimitBreakdown!["transport"]).toBeGreaterThan(0);

    expect(status.rateLimitRecentEvents).toBeDefined();
    expect(status.rateLimitRecentEvents!.length).toBeGreaterThan(0);
    const recentEvent = status.rateLimitRecentEvents![0];
    expect(recentEvent).toBeDefined();
    expect(recentEvent.trackBy).toBe("transport");

    baseTransport.closeSource();
  });
});
