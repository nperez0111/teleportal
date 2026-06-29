import { describe, it } from "bun:test";
import * as Y from "yjs";
import { withRateLimit, type RateLimitRule } from "../src/transports/rate-limiter";
import { withMessageValidator } from "../src/transports/message-validator";
import {
  calculateTokensToAdd,
  refillRateLimitState,
  createInitialState,
  getRateLimitKey,
} from "../src/storage/rate-limit-utils";
import { UnstorageRateLimitStorage } from "../src/storage/unstorage/rate-limit-storage";
import { TieredRateLimitStorage } from "../src/storage/tiered-rate-limit-storage";
import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";
import { DocMessage, type Message, type ServerContext, type Transport } from "teleportal";
import type { VersionedUpdate, Update } from "teleportal";
import { encodeContentEncryptedPayload } from "../src/lib/protocol/encryption/encoding";
import { createChannel } from "../src/lib/iter";
import { bench, benchBatch } from "./helpers";

// ---------------------------------------------------------------------------
// Transport mock
// ---------------------------------------------------------------------------

class BenchTransport<Context extends ServerContext> implements Transport<Context> {
  public source: AsyncIterable<Message<Context>[]>;
  #channel = createChannel<Message<Context>>();
  public written: Message<Context>[] = [];

  constructor() {
    this.source = this.#channel;
  }

  write(message: Message<Context>): void {
    this.written.push(message);
  }
  close(): void {}
  async destroy() {}

  enqueueMessage(message: Message<Context>) {
    try {
      this.#channel.send(message);
    } catch {}
  }

  closeReadable() {
    this.#channel.close();
  }

  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helper — create a DocMessage with an encrypted-shaped payload
// ---------------------------------------------------------------------------

function makeDocUpdate(docId: string, content: string): DocMessage<ServerContext> {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const update = Y.encodeStateAsUpdateV2(doc);
  const payload = encodeContentEncryptedPayload({ structureUpdate: update, encryptedSidecars: [] });
  return new DocMessage(
    docId,
    { type: "update", update: { version: 2, data: payload as Update } as VersionedUpdate },
    { userId: "bench-user", room: "bench", clientId: "bench-client" },
    false,
  );
}

// ---------------------------------------------------------------------------
// Default rules — mirrors the production defaultRateLimitRules() with 3 rules,
// each having a shouldSkipRule callback to simulate realistic per-message cost.
// ---------------------------------------------------------------------------

function defaultRateLimitRules<Context extends ServerContext>(): RateLimitRule<Context>[] {
  return [
    {
      id: "sync-per-user",
      maxMessages: 300,
      windowMs: 1000,
      trackBy: "user",
      shouldSkipRule: () => false,
    },
    {
      id: "sync-per-document",
      maxMessages: 1500,
      windowMs: 10_000,
      trackBy: "document",
      shouldSkipRule: () => false,
    },
    {
      id: "file-transfer-per-user",
      maxMessages: 200,
      windowMs: 1000,
      trackBy: "user",
      shouldSkipRule: () => true, // skipped for normal doc messages
    },
  ];
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("Rate Limiter Benchmarks", () => {
  // -----------------------------------------------------------------------
  // 1. Token bucket primitives
  // -----------------------------------------------------------------------

  describe("Token bucket primitives", () => {
    it("calculateTokensToAdd", async () => {
      console.log("    pure math — no allocations");
      await bench(
        "calculateTokensToAdd",
        () => {
          calculateTokensToAdd(500, 1000, 300);
        },
        { iterations: 5000 },
      );
    });

    it("refillRateLimitState", async () => {
      const state = createInitialState(1000, 300);
      state.tokens = 100; // partially consumed
      const futureTime = Date.now() + 500;

      console.log("    state update — spread + math");
      await bench(
        "refillRateLimitState",
        () => {
          refillRateLimitState(state, futureTime);
        },
        { iterations: 5000 },
      );
    });

    it("createInitialState", async () => {
      console.log("    allocation — object literal + Date.now()");
      await bench(
        "createInitialState",
        () => {
          createInitialState(1000, 300);
        },
        { iterations: 5000 },
      );
    });

    it("getRateLimitKey — all trackBy modes", async () => {
      console.log("    string construction per trackBy mode");
      await bench(
        "getRateLimitKey (user)",
        () => {
          getRateLimitKey("sync-per-user", "user-123", undefined, "user");
        },
        { iterations: 5000 },
      );

      await bench(
        "getRateLimitKey (document)",
        () => {
          getRateLimitKey("sync-per-doc", undefined, "doc-abc", "document");
        },
        { iterations: 5000 },
      );

      await bench(
        "getRateLimitKey (user-document)",
        () => {
          getRateLimitKey("combo", "user-123", "doc-abc", "user-document");
        },
        { iterations: 5000 },
      );

      await bench(
        "getRateLimitKey (transport — returns null)",
        () => {
          getRateLimitKey("transport-rule", undefined, undefined, "transport");
        },
        { iterations: 5000 },
      );
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // 2. Rate limit check — transport-scoped (in-memory bucket, no storage)
  // -----------------------------------------------------------------------

  describe("Rate limit check — transport-scoped (in-memory bucket)", () => {
    it("single rule, transport trackBy", async () => {
      const transport = new BenchTransport<ServerContext>();
      const rule: RateLimitRule<ServerContext> = {
        id: "bench",
        maxMessages: 100_000,
        windowMs: 60_000,
        trackBy: "transport",
      };
      const wrapped = withRateLimit(transport, { rules: [rule] });
      const msg = makeDocUpdate("bench-doc", "hello");

      console.log("    1 rule, trackBy=transport, maxMessages=100000");
      await bench(
        "write through transport-scoped rate limiter",
        async () => {
          await wrapped.write(msg);
        },
        { iterations: 1000 },
      );
    });
  });

  // -----------------------------------------------------------------------
  // 3. Rate limit check — storage-backed (unstorage/memory driver)
  // -----------------------------------------------------------------------

  describe("Rate limit check — storage-backed (unstorage/memory)", () => {
    it("single rule, user trackBy with memory storage", async () => {
      const storage = createStorage({ driver: memoryDriver() });
      const rateLimitStorage = new UnstorageRateLimitStorage(storage);

      const transport = new BenchTransport<ServerContext>();
      const rule: RateLimitRule<ServerContext> = {
        id: "bench-storage",
        maxMessages: 100_000,
        windowMs: 60_000,
        trackBy: "user",
      };
      const wrapped = withRateLimit(transport, {
        rules: [rule],
        rateLimitStorage,
      });
      const msg = makeDocUpdate("bench-doc", "hello");

      console.log("    1 rule, trackBy=user, unstorage memory driver");
      await bench(
        "write through storage-backed rate limiter",
        async () => {
          await wrapped.write(msg);
        },
        { iterations: 200 },
      );
    });

    it("single rule, user trackBy with tiered cache", async () => {
      const storage = createStorage({ driver: memoryDriver() });
      const backing = new UnstorageRateLimitStorage(storage);
      const rateLimitStorage = new TieredRateLimitStorage(backing);

      const transport = new BenchTransport<ServerContext>();
      const rule: RateLimitRule<ServerContext> = {
        id: "bench-tiered",
        maxMessages: 100_000,
        windowMs: 60_000,
        trackBy: "user",
      };
      const wrapped = withRateLimit(transport, {
        rules: [rule],
        rateLimitStorage,
      });
      const msg = makeDocUpdate("bench-doc", "hello");

      console.log("    1 rule, trackBy=user, tiered (in-memory cache + unstorage)");
      await bench(
        "write through tiered-cached rate limiter",
        async () => {
          await wrapped.write(msg);
        },
        { iterations: 200 },
      );
    });
  });

  // -----------------------------------------------------------------------
  // 4. Rate limit with default rules (3 rules checked per message)
  // -----------------------------------------------------------------------

  describe("Rate limit with default rules (3 rules)", () => {
    it("default rules — transport-scoped (no storage)", async () => {
      const rules = defaultRateLimitRules<ServerContext>();
      // Raise limits so we never actually hit them
      for (const rule of rules) {
        rule.maxMessages = 100_000;
        rule.windowMs = 60_000;
      }

      const transport = new BenchTransport<ServerContext>();
      const wrapped = withRateLimit(transport, { rules });
      const msg = makeDocUpdate("bench-doc", "hello");

      console.log("    3 default rules, each with shouldSkipRule callback");
      await bench(
        "write through 3 default rules (no storage)",
        async () => {
          await wrapped.write(msg);
        },
        { iterations: 1000 },
      );
    });

    it("default rules — storage-backed", async () => {
      const storage = createStorage({ driver: memoryDriver() });
      const rateLimitStorage = new UnstorageRateLimitStorage(storage);

      const rules = defaultRateLimitRules<ServerContext>();
      for (const rule of rules) {
        rule.maxMessages = 100_000;
        rule.windowMs = 60_000;
      }

      const transport = new BenchTransport<ServerContext>();
      const wrapped = withRateLimit(transport, {
        rules,
        rateLimitStorage,
      });
      const msg = makeDocUpdate("bench-doc", "hello");

      console.log("    3 default rules, unstorage memory driver");
      await bench(
        "write through 3 default rules (storage-backed)",
        async () => {
          await wrapped.write(msg);
        },
        { iterations: 200 },
      );
    });

    it("default rules — storage-backed with tiered cache", async () => {
      const storage = createStorage({ driver: memoryDriver() });
      const backing = new UnstorageRateLimitStorage(storage);
      const rateLimitStorage = new TieredRateLimitStorage(backing);

      const rules = defaultRateLimitRules<ServerContext>();
      for (const rule of rules) {
        rule.maxMessages = 100_000;
        rule.windowMs = 60_000;
      }

      const transport = new BenchTransport<ServerContext>();
      const wrapped = withRateLimit(transport, {
        rules,
        rateLimitStorage,
      });
      const msg = makeDocUpdate("bench-doc", "hello");

      console.log("    3 default rules, tiered (in-memory cache + unstorage)");
      await bench(
        "write through 3 default rules (tiered cache)",
        async () => {
          await wrapped.write(msg);
        },
        { iterations: 200 },
      );
    });
  });

  // -----------------------------------------------------------------------
  // 5. Rate limit overhead on message throughput (burst)
  // -----------------------------------------------------------------------

  describe("Rate limit overhead — burst throughput", () => {
    it("raw transport vs rate-limited (100 msg burst)", async () => {
      const BATCH = 100;
      const msg = makeDocUpdate("bench-doc", "burst payload");
      console.log("    comparing raw write vs rate-limited write, batch=" + BATCH);

      // Raw transport baseline
      {
        const transport = new BenchTransport<ServerContext>();
        await benchBatch(
          "raw transport write (baseline)",
          () => {
            for (let i = 0; i < BATCH; i++) transport.write(msg);
          },
          { batchSize: BATCH, iterations: 20 },
        );
      }

      // Rate-limited transport (transport-scoped, 1 rule)
      {
        const transport = new BenchTransport<ServerContext>();
        const rule: RateLimitRule<ServerContext> = {
          id: "burst-bench",
          maxMessages: 1_000_000,
          windowMs: 60_000,
          trackBy: "transport",
        };
        const wrapped = withRateLimit(transport, { rules: [rule] });
        await benchBatch(
          "rate-limited write (1 rule, transport-scoped)",
          async () => {
            for (let i = 0; i < BATCH; i++) await wrapped.write(msg);
          },
          { batchSize: BATCH, iterations: 20 },
        );
      }

      // Rate-limited transport (3 default rules)
      {
        const transport = new BenchTransport<ServerContext>();
        const rules = defaultRateLimitRules<ServerContext>();
        for (const rule of rules) {
          rule.maxMessages = 1_000_000;
          rule.windowMs = 60_000;
        }
        const wrapped = withRateLimit(transport, { rules });
        await benchBatch(
          "rate-limited write (3 default rules)",
          async () => {
            for (let i = 0; i < BATCH; i++) await wrapped.write(msg);
          },
          { batchSize: BATCH, iterations: 20 },
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  // 6. withMessageValidator overhead
  // -----------------------------------------------------------------------

  describe("withMessageValidator overhead", () => {
    it("sync isAuthorized callback", async () => {
      const transport = new BenchTransport<ServerContext>();
      const validated = withMessageValidator(transport, {
        isAuthorized: () => Promise.resolve(true),
      });
      const msg = makeDocUpdate("bench-doc", "hello");

      console.log("    isAuthorized: () => Promise.resolve(true)");
      await bench(
        "write with sync-like validator",
        async () => {
          await validated.write(msg);
        },
        { iterations: 1000 },
      );
    });

    it("async isAuthorized callback", async () => {
      const transport = new BenchTransport<ServerContext>();
      const validated = withMessageValidator(transport, {
        isAuthorized: async () => true,
      });
      const msg = makeDocUpdate("bench-doc", "hello");

      console.log("    isAuthorized: async () => true (real async)");
      await bench(
        "write with async validator",
        async () => {
          await validated.write(msg);
        },
        { iterations: 1000 },
      );
    });

    it("raw transport baseline (no validator)", async () => {
      const transport = new BenchTransport<ServerContext>();
      const msg = makeDocUpdate("bench-doc", "hello");

      await bench(
        "raw write (no validator, baseline)",
        () => {
          transport.write(msg);
        },
        { iterations: 1000 },
      );
    });
  });

  // -----------------------------------------------------------------------
  // 7. Combined rate-limit + message-validator
  // -----------------------------------------------------------------------

  describe("Combined rate-limit + message-validator", () => {
    it("rate-limit (1 rule, transport) + validator", async () => {
      const transport = new BenchTransport<ServerContext>();
      const rule: RateLimitRule<ServerContext> = {
        id: "combined-bench",
        maxMessages: 100_000,
        windowMs: 60_000,
        trackBy: "transport",
      };
      const rateLimited = withRateLimit(transport, { rules: [rule] });
      const combined = withMessageValidator(rateLimited, {
        isAuthorized: async () => true,
      });
      const msg = makeDocUpdate("bench-doc", "hello");

      console.log("    1 transport rule + async validator");
      await bench(
        "write through rate-limit + validator",
        async () => {
          await combined.write(msg);
        },
        { iterations: 1000 },
      );
    });

    it("rate-limit (3 default rules) + validator", async () => {
      const transport = new BenchTransport<ServerContext>();
      const rules = defaultRateLimitRules<ServerContext>();
      for (const rule of rules) {
        rule.maxMessages = 100_000;
        rule.windowMs = 60_000;
      }
      const rateLimited = withRateLimit(transport, { rules });
      const combined = withMessageValidator(rateLimited, {
        isAuthorized: async () => true,
      });
      const msg = makeDocUpdate("bench-doc", "hello");

      console.log("    3 default rules + async validator");
      await bench(
        "write through 3 rules + validator",
        async () => {
          await combined.write(msg);
        },
        { iterations: 1000 },
      );
    });

    it("rate-limit (3 default rules, storage) + validator", async () => {
      const storage = createStorage({ driver: memoryDriver() });
      const rateLimitStorage = new UnstorageRateLimitStorage(storage);

      const transport = new BenchTransport<ServerContext>();
      const rules = defaultRateLimitRules<ServerContext>();
      for (const rule of rules) {
        rule.maxMessages = 100_000;
        rule.windowMs = 60_000;
      }
      const rateLimited = withRateLimit(transport, {
        rules,
        rateLimitStorage,
      });
      const combined = withMessageValidator(rateLimited, {
        isAuthorized: async () => true,
      });
      const msg = makeDocUpdate("bench-doc", "hello");

      console.log("    3 default rules (storage) + async validator");
      await bench(
        "write through 3 rules (storage) + validator",
        async () => {
          await combined.write(msg);
        },
        { iterations: 200 },
      );
    });
  });
});
