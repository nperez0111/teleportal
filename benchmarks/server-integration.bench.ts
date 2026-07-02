import { describe, it, beforeEach } from "bun:test";
import * as Y from "yjs";
import { Server } from "../src/server/server";
import { MemoryDocumentStorage } from "../src/storage/in-memory/document-storage";
import {
  DocMessage,
  InMemoryPubSub,
  type Message,
  type ServerContext,
  type StateVector,
  type Transport,
  type Update,
  type VersionedUpdate,
} from "teleportal";
import { createChannel } from "../src/lib/iter";
import { encodeContentEncryptedPayload } from "../src/lib/protocol/encryption/encoding";
import { UnstorageRateLimitStorage } from "../src/storage/unstorage/rate-limit-storage";
import { defaultRateLimitRules } from "../src/transports/rate-limiter";
import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";
import { bench, benchBatch, flush } from "./helpers";

// ---------------------------------------------------------------------------
// Transport mock (same as server.bench.test.ts)
// ---------------------------------------------------------------------------

class BenchTransport<Context extends ServerContext> implements Transport<Context> {
  public source: AsyncIterable<Message<Context>[]>;
  #channel = createChannel<Message<Context>>();

  constructor() {
    this.source = this.#channel;
  }

  write(_message: Message<Context>): void {}
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
// Helpers
// ---------------------------------------------------------------------------

function wrapUpdate(rawV2: Uint8Array): VersionedUpdate {
  const payload = encodeContentEncryptedPayload({
    structureUpdate: rawV2,
    encryptedSidecars: [],
  });
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

function makeDocUpdate(docId: string, content: string): DocMessage<ServerContext> {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  return new DocMessage(
    docId,
    { type: "update", update: wrapUpdate(Y.encodeStateAsUpdateV2(doc)) },
    { userId: "bench-user", room: "bench", clientId: "bench-client" },
    false,
  );
}

function makeIncrementalDocUpdate(
  doc: Y.Doc,
  docId: string,
  text: string,
  pos: number,
): DocMessage<ServerContext> {
  const sv = Y.encodeStateVector(doc);
  doc.getText("content").insert(pos, text);
  const diff = Y.encodeStateAsUpdateV2(doc, sv);
  return new DocMessage(
    docId,
    { type: "update", update: wrapUpdate(diff) },
    { userId: "bench-user", room: "bench", clientId: "bench-client" },
    false,
  );
}

function makeSyncStep1(docId: string): DocMessage<ServerContext> {
  const doc = new Y.Doc();
  const sv = Y.encodeStateVector(doc);
  return new DocMessage(
    docId,
    { type: "sync-step-1", sv: sv as StateVector },
    { userId: "bench-user", room: "bench", clientId: "bench-client" },
    false,
  );
}

// ---------------------------------------------------------------------------
// Server factory helpers
// ---------------------------------------------------------------------------

function createRateLimitStorage() {
  return new UnstorageRateLimitStorage(createStorage({ driver: memoryDriver() }), {
    ttl: 5000,
    baseDelay: 1,
  });
}

function createBaselineServer(storage: MemoryDocumentStorage, pubSub: InMemoryPubSub) {
  return new Server<ServerContext>({ storage, pubSub });
}

function createServerWithPermission(storage: MemoryDocumentStorage, pubSub: InMemoryPubSub) {
  return new Server<ServerContext>({
    storage,
    pubSub,
    checkPermission: async () => true,
  });
}

function createServerWithRateLimit(storage: MemoryDocumentStorage, pubSub: InMemoryPubSub) {
  return new Server<ServerContext>({
    storage,
    pubSub,
    rateLimitConfig: {
      rules: defaultRateLimitRules(),
      rateLimitStorage: createRateLimitStorage(),
      getUserId: (msg) => msg.context?.userId,
      getDocumentId: (msg) => (msg as DocMessage<ServerContext>).document,
    },
  });
}

function createServerWithAttribution(storage: MemoryDocumentStorage, pubSub: InMemoryPubSub) {
  return new Server<ServerContext>({
    storage,
    pubSub,
    attributionConfig: {},
  });
}

function createServerWithAllMiddleware(storage: MemoryDocumentStorage, pubSub: InMemoryPubSub) {
  return new Server<ServerContext>({
    storage,
    pubSub,
    checkPermission: async () => true,
    rateLimitConfig: {
      rules: defaultRateLimitRules(),
      rateLimitStorage: createRateLimitStorage(),
      getUserId: (msg) => msg.context?.userId,
      getDocumentId: (msg) => (msg as DocMessage<ServerContext>).document,
    },
    attributionConfig: {},
  });
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("Server Integration Benchmarks (with middleware)", () => {
  beforeEach(() => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    MemoryDocumentStorage.attributionMaps.clear();
  });

  // -----------------------------------------------------------------------
  // 1. Permission check overhead
  // -----------------------------------------------------------------------
  describe("Permission check overhead", () => {
    it("per-message overhead of checkPermission", async () => {
      const pubSub = new InMemoryPubSub();
      const storage = new MemoryDocumentStorage(false);

      const baseline = createBaselineServer(storage, pubSub);
      const withPerm = createServerWithPermission(storage, pubSub);

      const tBaseline = new BenchTransport<ServerContext>();
      baseline.createClient({ transport: tBaseline });

      const tPerm = new BenchTransport<ServerContext>();
      withPerm.createClient({ transport: tPerm });

      let i = 0;
      const baseResult = await bench(
        "update (no middleware)",
        async () => {
          tBaseline.enqueueMessage(makeDocUpdate("perm-doc", `b-${i++}`));
          await flush();
        },
        { iterations: 200 },
      );

      let j = 0;
      const permResult = await bench(
        "update (permission check)",
        async () => {
          tPerm.enqueueMessage(makeDocUpdate("perm-doc", `p-${j++}`));
          await flush();
        },
        { iterations: 200 },
      );

      const overhead = permResult.avgMs - baseResult.avgMs;
      console.log(`    overhead: ${(overhead * 1000).toFixed(0)}μs per message`);

      tBaseline.closeReadable();
      tPerm.closeReadable();
      await baseline[Symbol.asyncDispose]();
      await withPerm[Symbol.asyncDispose]();
      await pubSub[Symbol.asyncDispose]();
    });
  });

  // -----------------------------------------------------------------------
  // 2. Rate limiting overhead
  // -----------------------------------------------------------------------
  describe("Rate limiting overhead", () => {
    it("per-message overhead of rate limiting", async () => {
      const pubSub = new InMemoryPubSub();
      const storage = new MemoryDocumentStorage(false);

      const baseline = createBaselineServer(storage, pubSub);
      const withRL = createServerWithRateLimit(storage, pubSub);

      const tBaseline = new BenchTransport<ServerContext>();
      baseline.createClient({ transport: tBaseline });

      const tRL = new BenchTransport<ServerContext>();
      withRL.createClient({ transport: tRL });

      let i = 0;
      const baseResult = await bench(
        "update (no middleware)",
        async () => {
          tBaseline.enqueueMessage(makeDocUpdate("rl-doc", `b-${i++}`));
          await flush();
        },
        { iterations: 200 },
      );

      let j = 0;
      const rlResult = await bench(
        "update (rate limited)",
        async () => {
          tRL.enqueueMessage(makeDocUpdate("rl-doc", `r-${j++}`));
          await flush();
        },
        { iterations: 200 },
      );

      const overhead = rlResult.avgMs - baseResult.avgMs;
      console.log(`    overhead: ${(overhead * 1000).toFixed(0)}μs per message`);

      tBaseline.closeReadable();
      tRL.closeReadable();
      await baseline[Symbol.asyncDispose]();
      await withRL[Symbol.asyncDispose]();
      await pubSub[Symbol.asyncDispose]();
    });
  });

  // -----------------------------------------------------------------------
  // 3. Attribution overhead
  // -----------------------------------------------------------------------
  describe("Attribution overhead", () => {
    it("per-message overhead of attribution", async () => {
      const pubSub = new InMemoryPubSub();
      const storage = new MemoryDocumentStorage(false);

      const baseline = createBaselineServer(storage, pubSub);
      const withAttr = createServerWithAttribution(storage, pubSub);

      const tBaseline = new BenchTransport<ServerContext>();
      baseline.createClient({ transport: tBaseline });

      const tAttr = new BenchTransport<ServerContext>();
      withAttr.createClient({ transport: tAttr });

      let i = 0;
      const baseResult = await bench(
        "update (no middleware)",
        async () => {
          tBaseline.enqueueMessage(makeDocUpdate("attr-doc", `b-${i++}`));
          await flush();
        },
        { iterations: 200 },
      );

      let j = 0;
      const attrResult = await bench(
        "update (attribution)",
        async () => {
          tAttr.enqueueMessage(makeDocUpdate("attr-doc", `a-${j++}`));
          await flush();
        },
        { iterations: 200 },
      );

      const overhead = attrResult.avgMs - baseResult.avgMs;
      console.log(`    overhead: ${(overhead * 1000).toFixed(0)}μs per message`);

      tBaseline.closeReadable();
      tAttr.closeReadable();
      await baseline[Symbol.asyncDispose]();
      await withAttr[Symbol.asyncDispose]();
      await pubSub[Symbol.asyncDispose]();
    });
  });

  // -----------------------------------------------------------------------
  // 4. All middleware combined
  // -----------------------------------------------------------------------
  describe("All middleware combined", () => {
    it("per-message overhead of permission + rate limiting + attribution", async () => {
      const pubSub = new InMemoryPubSub();
      const storage = new MemoryDocumentStorage(false);

      const baseline = createBaselineServer(storage, pubSub);
      const withAll = createServerWithAllMiddleware(storage, pubSub);

      const tBaseline = new BenchTransport<ServerContext>();
      baseline.createClient({ transport: tBaseline });

      const tAll = new BenchTransport<ServerContext>();
      withAll.createClient({ transport: tAll });

      let i = 0;
      const baseResult = await bench(
        "update (no middleware)",
        async () => {
          tBaseline.enqueueMessage(makeDocUpdate("all-doc", `b-${i++}`));
          await flush();
        },
        { iterations: 200 },
      );

      let j = 0;
      const allResult = await bench(
        "update (all middleware)",
        async () => {
          tAll.enqueueMessage(makeDocUpdate("all-doc", `a-${j++}`));
          await flush();
        },
        { iterations: 200 },
      );

      const overhead = allResult.avgMs - baseResult.avgMs;
      console.log(`    overhead: ${(overhead * 1000).toFixed(0)}μs per message`);

      tBaseline.closeReadable();
      tAll.closeReadable();
      await baseline[Symbol.asyncDispose]();
      await withAll[Symbol.asyncDispose]();
      await pubSub[Symbol.asyncDispose]();
    });

    it("incremental edits with all middleware", async () => {
      const pubSub = new InMemoryPubSub();
      const storage = new MemoryDocumentStorage(false);

      const withAll = createServerWithAllMiddleware(storage, pubSub);

      const transport = new BenchTransport<ServerContext>();
      withAll.createClient({ transport });

      const doc = new Y.Doc();
      let pos = 0;
      await bench(
        "incremental edit (all middleware)",
        async () => {
          transport.enqueueMessage(makeIncrementalDocUpdate(doc, "inc-doc", "x", pos++));
          await flush();
        },
        { iterations: 200 },
      );

      transport.closeReadable();
      await withAll[Symbol.asyncDispose]();
      await pubSub[Symbol.asyncDispose]();
    });
  });

  // -----------------------------------------------------------------------
  // 5. Concurrent multi-document sessions
  // -----------------------------------------------------------------------
  describe("Concurrent multi-document sessions", () => {
    it("round-robin updates across 10 documents", async () => {
      const pubSub = new InMemoryPubSub();
      const storage = new MemoryDocumentStorage(false);

      const server = createServerWithAllMiddleware(storage, pubSub);

      const transport = new BenchTransport<ServerContext>();
      server.createClient({ transport });

      // Pre-open sessions for all 10 documents
      const docCount = 10;
      for (let d = 0; d < docCount; d++) {
        transport.enqueueMessage(makeSyncStep1(`multi-doc-${d}`));
      }
      await flush();
      await new Promise((r) => setTimeout(r, 1));

      let docIdx = 0;
      let updateIdx = 0;
      await bench(
        `round-robin update across ${docCount} docs (all middleware)`,
        async () => {
          const docId = `multi-doc-${docIdx % docCount}`;
          transport.enqueueMessage(makeDocUpdate(docId, `u-${updateIdx++}`));
          docIdx++;
          await flush();
        },
        { iterations: 200 },
      );

      transport.closeReadable();
      await server[Symbol.asyncDispose]();
      await pubSub[Symbol.asyncDispose]();
    });

    it("batch updates across 10 documents", async () => {
      const pubSub = new InMemoryPubSub();
      const storage = new MemoryDocumentStorage(false);

      const server = createServerWithAllMiddleware(storage, pubSub);

      const transport = new BenchTransport<ServerContext>();
      server.createClient({ transport });

      const docCount = 10;
      for (let d = 0; d < docCount; d++) {
        transport.enqueueMessage(makeSyncStep1(`batch-doc-${d}`));
      }
      await flush();
      await new Promise((r) => setTimeout(r, 1));

      let batchNum = 0;
      await benchBatch(
        `batch of ${docCount} doc updates (all middleware)`,
        async () => {
          for (let d = 0; d < docCount; d++) {
            transport.enqueueMessage(makeDocUpdate(`batch-doc-${d}`, `b-${batchNum++}`));
          }
          await flush();
          await new Promise((r) => setTimeout(r, 1));
        },
        { batchSize: docCount, iterations: 20 },
      );

      transport.closeReadable();
      await server[Symbol.asyncDispose]();
      await pubSub[Symbol.asyncDispose]();
    });
  });

  // -----------------------------------------------------------------------
  // 6. Multi-client fan-out with middleware
  // -----------------------------------------------------------------------
  describe("Multi-client fan-out with middleware", () => {
    it("fan-out with rate limiting vs without", async () => {
      const clientCount = 10;

      // --- Without rate limiting ---
      const pubSubBase = new InMemoryPubSub();
      const storageBase = new MemoryDocumentStorage(false);
      const baseline = createBaselineServer(storageBase, pubSubBase);

      const baseTransports: BenchTransport<ServerContext>[] = [];
      for (let i = 0; i < clientCount; i++) {
        const t = new BenchTransport<ServerContext>();
        baseline.createClient({ transport: t });
        baseTransports.push(t);
      }

      for (const t of baseTransports) {
        t.enqueueMessage(makeSyncStep1("fanout-base"));
      }
      await flush();
      await new Promise((r) => setTimeout(r, 1));

      const baseResult = await bench(
        `fan-out to ${clientCount} clients (no middleware)`,
        async () => {
          baseTransports[0].enqueueMessage(makeDocUpdate("fanout-base", "x"));
          await flush();
        },
        { iterations: 100 },
      );

      for (const t of baseTransports) t.closeReadable();

      // --- With rate limiting ---
      const pubSubRL = new InMemoryPubSub();
      const storageRL = new MemoryDocumentStorage(false);
      const withRL = createServerWithRateLimit(storageRL, pubSubRL);

      const rlTransports: BenchTransport<ServerContext>[] = [];
      for (let i = 0; i < clientCount; i++) {
        const t = new BenchTransport<ServerContext>();
        withRL.createClient({ transport: t });
        rlTransports.push(t);
      }

      for (const t of rlTransports) {
        t.enqueueMessage(makeSyncStep1("fanout-rl"));
      }
      await flush();
      await new Promise((r) => setTimeout(r, 1));

      const rlResult = await bench(
        `fan-out to ${clientCount} clients (rate limited)`,
        async () => {
          rlTransports[0].enqueueMessage(makeDocUpdate("fanout-rl", "x"));
          await flush();
        },
        { iterations: 100 },
      );

      const overhead = rlResult.avgMs - baseResult.avgMs;
      console.log(`    overhead: ${(overhead * 1000).toFixed(0)}μs per fan-out`);

      for (const t of rlTransports) t.closeReadable();
      await baseline[Symbol.asyncDispose]();
      await withRL[Symbol.asyncDispose]();
      await pubSubBase[Symbol.asyncDispose]();
      await pubSubRL[Symbol.asyncDispose]();
    });
  });

  // -----------------------------------------------------------------------
  // 7. Session open under load
  // -----------------------------------------------------------------------
  describe("Session open under load", () => {
    it("open session with 0 vs 50 existing sessions", async () => {
      const pubSub = new InMemoryPubSub();
      const storage = new MemoryDocumentStorage(false);

      // --- Cold server (session 1) ---
      const coldServer = createServerWithAllMiddleware(storage, pubSub);

      let coldIdx = 0;
      const coldResult = await bench(
        "open session (cold server, all middleware)",
        async () => {
          await coldServer.getOrOpenSession(`cold-doc-${coldIdx++}`, {
            encrypted: false,
            context: { userId: "user-1", room: "bench", clientId: "client-1" },
          });
        },
        { iterations: 200 },
      );

      await coldServer[Symbol.asyncDispose]();

      // --- Warm server (50 existing sessions) ---
      MemoryDocumentStorage.docs.clear();
      MemoryDocumentStorage.pendingUpdates.clear();
      MemoryDocumentStorage.attributionMaps.clear();

      const warmServer = createServerWithAllMiddleware(storage, pubSub);

      // Pre-load 50 sessions
      for (let i = 0; i < 50; i++) {
        await warmServer.getOrOpenSession(`preload-doc-${i}`, {
          encrypted: false,
          context: { userId: "user-1", room: "bench", clientId: "client-1" },
        });
      }

      let warmIdx = 0;
      const warmResult = await bench(
        "open session (50 existing, all middleware)",
        async () => {
          await warmServer.getOrOpenSession(`warm-doc-${warmIdx++}`, {
            encrypted: false,
            context: { userId: "user-1", room: "bench", clientId: "client-1" },
          });
        },
        { iterations: 200 },
      );

      const overhead = warmResult.avgMs - coldResult.avgMs;
      console.log(`    overhead: ${(overhead * 1000).toFixed(0)}μs per session open`);

      await warmServer[Symbol.asyncDispose]();
      await pubSub[Symbol.asyncDispose]();
    });
  });
});
