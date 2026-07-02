import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import crossws from "crossws/adapters/bun";
import * as Y from "yjs";
import { createEncryptionKey } from "teleportal/encryption-key";
import {
  InMemoryPubSub,
  type Message,
  type ServerContext,
  type Update,
  type VersionedUpdate,
  type VersionedSyncStep2Update,
} from "teleportal";
import { MemoryDocumentStorage } from "teleportal/storage";
import { getAttributionRpcHandlers } from "teleportal/protocols/attribution";
import { Server } from "../../server/server";
import { Client } from "../../server/client";
import type { Session } from "../../server/session";
import { EncryptionClient } from "./client";
import { getWebsocketHandlers } from "../../websocket-server";
import { DirectConnection as Connection } from "../../providers/connection";
import { websocketTransport } from "../../providers/transports/websocket";
import { Provider } from "../../providers/provider";
import { createAttributionRpc } from "../../protocols/attribution/client";

type Ctx = ServerContext;

function createServerClient(id: string, onMessage: (msg: Message<Ctx>) => void): Client<Ctx> {
  return new Client<Ctx>({ id, write: (chunk) => onMessage(chunk) });
}

// ─── Unit-level encrypted sync tests (no real transport) ───────────────────

describe("encrypted sync e2e: two clients via server", () => {
  let storage: MemoryDocumentStorage;
  let pubSub: InMemoryPubSub;
  let server: Server<Ctx>;
  let key: CryptoKey;

  beforeEach(async () => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    storage = new MemoryDocumentStorage(true);
    pubSub = new InMemoryPubSub();
    key = await createEncryptionKey();

    server = new Server<Ctx>({
      storage: async () => storage,
      pubSub,
    });
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  async function performSyncHandshake(
    encClient: EncryptionClient,
    session: Session<Ctx>,
    serverClient: Client<Ctx>,
    inbox: Message<Ctx>[],
  ) {
    const syncStep1 = await encClient.start();
    inbox.length = 0;
    await session.apply(syncStep1 as Message<Ctx>, serverClient);

    for (const msg of inbox) {
      if (msg.type !== "doc") continue;
      if (msg.payload.type === "sync-step-2") {
        await encClient.handleSyncStep2(msg.payload.update as unknown as VersionedSyncStep2Update);
      } else if (msg.payload.type === "sync-step-1") {
        const resp = await encClient.handleSyncStep1(msg.payload.sv as unknown as Uint8Array);
        inbox.length = 0;
        await session.apply(resp as Message<Ctx>, serverClient);
      }
    }
  }

  async function sendUpdateToServer(
    encClient: EncryptionClient,
    ydoc: Y.Doc,
    session: Session<Ctx>,
    serverClient: Client<Ctx>,
  ) {
    const update = { version: 2, data: Y.encodeStateAsUpdateV2(ydoc) as Update } as VersionedUpdate;
    const msg = await encClient.onUpdate(update);
    await session.apply(msg as Message<Ctx>, serverClient);
  }

  async function applyBroadcastedUpdates(encClient: EncryptionClient, inbox: Message<Ctx>[]) {
    for (const msg of inbox) {
      if (msg.type !== "doc") continue;
      if (msg.payload.type === "update") {
        await encClient.handleUpdate(msg.payload.update as unknown as VersionedUpdate);
      }
    }
  }

  it("client A writes, client B connects and receives the document", async () => {
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocA,
      key,
    });
    const inboxA: Message<Ctx>[] = [];
    const serverClientA = createServerClient("client-a", (msg) => inboxA.push(msg));

    const session = await server.getOrOpenSession("doc-1", {
      encrypted: true,
      client: serverClientA,
      context: { userId: "client-a", room: "default", clientId: "client-a" },
    });
    await session.load();

    await performSyncHandshake(clientA, session, serverClientA, inboxA);

    ydocA.getText("body").insert(0, "hello from A");
    await sendUpdateToServer(clientA, ydocA, session, serverClientA);

    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocB,
      key,
    });
    const inboxB: Message<Ctx>[] = [];
    const serverClientB = createServerClient("client-b", (msg) => inboxB.push(msg));
    session.addClient(serverClientB);

    await performSyncHandshake(clientB, session, serverClientB, inboxB);

    expect(ydocB.getText("body").toString()).toBe("hello from A");

    clientA.destroy();
    clientB.destroy();
  });

  it("bidirectional sync: both clients exchange live updates", async () => {
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocA,
      key,
    });
    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocB,
      key,
    });

    const inboxA: Message<Ctx>[] = [];
    const inboxB: Message<Ctx>[] = [];
    const serverClientA = createServerClient("client-a", (msg) => inboxA.push(msg));
    const serverClientB = createServerClient("client-b", (msg) => inboxB.push(msg));

    const session = await server.getOrOpenSession("doc-1", {
      encrypted: true,
      client: serverClientA,
      context: { userId: "client-a", room: "default", clientId: "client-a" },
    });
    await session.load();

    await performSyncHandshake(clientA, session, serverClientA, inboxA);

    ydocA.getText("body").insert(0, "hello");
    inboxA.length = 0;
    inboxB.length = 0;
    await sendUpdateToServer(clientA, ydocA, session, serverClientA);

    session.addClient(serverClientB);
    await performSyncHandshake(clientB, session, serverClientB, inboxB);

    expect(ydocB.getText("body").toString()).toBe("hello");

    ydocB.getText("body").insert(5, " world");
    inboxA.length = 0;
    inboxB.length = 0;
    await sendUpdateToServer(clientB, ydocB, session, serverClientB);
    await applyBroadcastedUpdates(clientA, inboxA);

    expect(ydocA.getText("body").toString()).toBe("hello world");
    expect(ydocB.getText("body").toString()).toBe("hello world");

    ydocA.getText("body").insert(11, "!");
    inboxA.length = 0;
    inboxB.length = 0;
    await sendUpdateToServer(clientA, ydocA, session, serverClientA);
    await applyBroadcastedUpdates(clientB, inboxB);

    expect(ydocA.getText("body").toString()).toBe("hello world!");
    expect(ydocB.getText("body").toString()).toBe("hello world!");

    clientA.destroy();
    clientB.destroy();
  });

  it("concurrent edits from both clients converge", async () => {
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocA,
      key,
    });
    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocB,
      key,
    });

    const inboxA: Message<Ctx>[] = [];
    const inboxB: Message<Ctx>[] = [];
    const serverClientA = createServerClient("client-a", (msg) => inboxA.push(msg));
    const serverClientB = createServerClient("client-b", (msg) => inboxB.push(msg));

    const session = await server.getOrOpenSession("doc-1", {
      encrypted: true,
      client: serverClientA,
      context: { userId: "client-a", room: "default", clientId: "client-a" },
    });
    await session.load();

    await performSyncHandshake(clientA, session, serverClientA, inboxA);

    ydocA.getText("body").insert(0, "base");
    inboxA.length = 0;
    inboxB.length = 0;
    await sendUpdateToServer(clientA, ydocA, session, serverClientA);

    session.addClient(serverClientB);
    await performSyncHandshake(clientB, session, serverClientB, inboxB);
    expect(ydocB.getText("body").toString()).toBe("base");

    ydocA.getText("body").insert(0, "A:");
    ydocB.getText("body").insert(4, ":B");

    inboxA.length = 0;
    inboxB.length = 0;
    await sendUpdateToServer(clientA, ydocA, session, serverClientA);

    await applyBroadcastedUpdates(clientB, inboxB);

    inboxA.length = 0;
    inboxB.length = 0;
    await sendUpdateToServer(clientB, ydocB, session, serverClientB);

    await applyBroadcastedUpdates(clientA, inboxA);

    expect(ydocA.getText("body").toString()).toBe(ydocB.getText("body").toString());
    const text = ydocA.getText("body").toString();
    expect(text).toContain("A:");
    expect(text).toContain("base");
    expect(text).toContain(":B");

    clientA.destroy();
    clientB.destroy();
  });

  it("late-joining client receives document state after a single batch edit", async () => {
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocA,
      key,
    });

    const inboxA: Message<Ctx>[] = [];
    const serverClientA = createServerClient("client-a", (msg) => inboxA.push(msg));

    const session = await server.getOrOpenSession("doc-1", {
      encrypted: true,
      client: serverClientA,
      context: { userId: "client-a", room: "default", clientId: "client-a" },
    });
    await session.load();
    await performSyncHandshake(clientA, session, serverClientA, inboxA);

    // Client A makes edits (single transaction batch) then sends one update
    ydocA.getText("body").insert(0, "hello from A");
    ydocA.getText("title").insert(0, "My Title");
    await sendUpdateToServer(clientA, ydocA, session, serverClientA);

    // Client B joins late
    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocB,
      key,
    });
    const inboxB: Message<Ctx>[] = [];
    const serverClientB = createServerClient("client-b", (msg) => inboxB.push(msg));
    session.addClient(serverClientB);
    await performSyncHandshake(clientB, session, serverClientB, inboxB);

    expect(ydocB.getText("body").toString()).toBe("hello from A");
    expect(ydocB.getText("title").toString()).toBe("My Title");

    clientA.destroy();
    clientB.destroy();
  });
});

// ─── Full-stack WebSocket e2e tests ────────────────────────────────────────

describe("encrypted sync e2e: full WebSocket transport", () => {
  let pubSub: InMemoryPubSub;
  let server: Server<Ctx>;
  let key: CryptoKey;
  let bunServer: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const cleanups: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    pubSub = new InMemoryPubSub();
    key = await createEncryptionKey();

    server = new Server<Ctx>({
      storage: async (ctx) => {
        if (ctx.encrypted) {
          return new MemoryDocumentStorage(true);
        }
        return new MemoryDocumentStorage(false);
      },
      pubSub,
    });

    const ws = crossws({
      hooks: getWebsocketHandlers<Ctx>({
        server,
        onUpgrade: async () => ({
          context: { userId: "test-user", room: "test" },
        }),
      }),
    });

    bunServer = Bun.serve({
      port: 0,
      websocket: ws.websocket,
      async fetch(request, bunSrv) {
        if (request.headers.get("upgrade") === "websocket") {
          return ws.handleUpgrade(request, bunSrv);
        }
        return new Response("Not found", { status: 404 });
      },
    });

    baseUrl = `ws://localhost:${bunServer.port}`;
  });

  afterEach(async () => {
    // Bun does not isolate state between tests, so teardown must be ordered so
    // that no message reaches a torn-down client transport (which would surface
    // as a spurious "YDoc is destroyed" / closed-controller error in a later
    // test). First cut off the server so no new messages are broadcast...
    bunServer.stop(true);
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
    // ...then let any in-flight messages settle while clients are still alive...
    await new Promise((r) => setTimeout(r, 0));
    // ...and only then destroy the client providers/connections.
    for (const cleanup of cleanups.splice(0)) {
      try {
        await cleanup();
      } catch {
        // Best-effort teardown; ignore errors from already-closed resources.
      }
    }
    // Let any dangling rejections (e.g. ydoc transport synced promise) settle.
    await new Promise((r) => setTimeout(r, 0));
  });

  function createWsConnection(opts?: { connect?: boolean }) {
    const conn = new Connection({
      url: baseUrl,
      transports: [websocketTransport()],
      connect: opts?.connect ?? true,
      maxReconnectAttempts: 0,
      batchIntervalMs: 0,
    });
    cleanups.push(() => conn.destroy());
    return conn;
  }

  async function createProvider(
    document: string,
    opts?: { ydoc?: Y.Doc; encryptionKey?: CryptoKey | false },
  ) {
    const conn = createWsConnection();
    await conn.connected;

    const provider = await Provider.create({
      connection: conn,
      document,
      ydoc: opts?.ydoc,
      // Default to the explicit plaintext opt-out for the unencrypted tests;
      // encrypted tests pass a real key.
      encryptionKey: opts?.encryptionKey ?? false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      // Swallow the synced promise rejection that destroy triggers
      provider.transport.synced?.catch(() => {});
      provider.destroy();
    });
    return { provider, connection: conn };
  }

  /**
   * Builds a factory for `MemoryDocumentStorage` instances that all share one
   * backing Map. Each call to the factory returns a *fresh* storage object (as a
   * page reload would construct a fresh `IdbDocumentStorage`) but reads/writes
   * the same underlying data — standing in for IndexedDB persisting across
   * reloads, without needing a real IndexedDB in the bun test env.
   */
  function createPersistentStoreFactory(encrypted: boolean) {
    const backing = new Map<string, any>();
    const make = () =>
      new MemoryDocumentStorage(encrypted, {
        write: async (docKey, record) => {
          backing.set(docKey, record);
        },
        fetch: async (docKey) => backing.get(docKey),
        delete: async (docKey) => {
          backing.delete(docKey);
        },
      });
    return { make, backing };
  }

  /** Poll until `predicate` (sync or async) is true, or throw after `timeoutMs`. */
  async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 3000,
  ): Promise<void> {
    const start = performance.now();
    while (!(await predicate())) {
      if (performance.now() - start > timeoutMs) throw new Error("waitUntil timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /**
   * Decrypts a storage's persisted document with a throwaway EncryptionClient and
   * returns the reconstructed `body` text — exactly what a fresh provider would
   * restore. Used to wait until persistence has fully settled (a sidecar can land
   * before its structure update, leaving a transiently-incomplete state).
   */
  async function reconstructBody(
    store: MemoryDocumentStorage,
    docId: string,
    encKey: CryptoKey,
  ): Promise<string | null> {
    const doc = await store.getDocument(docId);
    if (!doc?.content.update) return null;
    const probe = new Y.Doc();
    const ec = new EncryptionClient({ document: docId, ydoc: probe, key: encKey });
    try {
      await ec.handleSyncStep2({
        version: 2,
        data: doc.content.update as unknown as VersionedSyncStep2Update["data"],
      } as unknown as VersionedSyncStep2Update);
    } catch {
      return null;
    }
    return probe.getText("body").toString();
  }

  function waitForSync(provider: Provider, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Sync timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (provider.transport.synced) {
        provider.transport.synced.then(() => {
          clearTimeout(timer);
          resolve();
        });
      } else {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  function waitForContent(
    ydoc: Y.Doc,
    field: string,
    predicate: (text: string) => boolean,
    timeoutMs = 5000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Timed out waiting for content. Current: "${ydoc.getText(field).toString()}"`),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        ydoc.getText(field).unobserve(check);
      };
      const check = () => {
        const text = ydoc.getText(field).toString();
        if (predicate(text)) {
          cleanup();
          resolve(text);
        }
      };
      ydoc.getText(field).observe(check);
      check();
    });
  }

  // --- Basic connectivity ---

  it("connects via WebSocket and reaches synced state", async () => {
    const { provider } = await createProvider("doc-ws-1");
    await waitForSync(provider);
    expect(provider.doc).toBeDefined();
  });

  it("single client writes and reads back after reconnect", async () => {
    const docId = "doc-ws-roundtrip";

    const { provider: p1, connection: c1 } = await createProvider(docId);
    await waitForSync(p1);

    p1.doc.getText("body").insert(0, "persisted text");
    await new Promise((r) => setTimeout(r, 1));

    p1.destroy();
    await c1.disconnect();

    const { provider: p2 } = await createProvider(docId);
    await waitForSync(p2);
    await new Promise((r) => setTimeout(r, 1));

    expect(p2.doc.getText("body").toString()).toBe("persisted text");
  });

  // --- Offline persistence: server-down restore ---

  it("restores an encrypted document from local storage with the server down", async () => {
    const docId = "doc-offline-restore";
    const { make: makeStore } = createPersistentStoreFactory(true);

    // 1. Connect, edit, and let the edit persist to local storage.
    const conn1 = createWsConnection();
    await conn1.connected;
    const p1 = new Provider({
      connection: conn1,
      document: docId,
      encryptionKey: key,
      enableOfflinePersistence: true,
      offlineStorage: makeStore(),
    });
    cleanups.push(() => {
      p1.transport.synced?.catch(() => {});
      p1.destroy();
    });
    await waitForSync(p1);

    p1.doc.getText("body").insert(0, "secret offline data");
    // The outgoing edit persists asynchronously via the transport seam, and a
    // sidecar can land before its structure update. Wait until the backing store
    // genuinely reconstructs the edit before tearing the writer down.
    await waitUntil(
      async () => (await reconstructBody(makeStore(), docId, key)) === "secret offline data",
    );

    p1.destroy();
    await conn1.disconnect();

    // 2. Take the server down entirely.
    bunServer.stop(true);

    // 3. A fresh provider, fresh Y.Doc, a connection that can never reach the
    //    (now-dead) server — but the SAME backing local storage.
    const conn2 = createWsConnection({ connect: false });
    const ydoc2 = new Y.Doc();
    const p2 = new Provider({
      connection: conn2,
      document: docId,
      ydoc: ydoc2,
      encryptionKey: key,
      enableOfflinePersistence: true,
      offlineStorage: makeStore(),
    });
    cleanups.push(() => {
      p2.transport.synced?.catch(() => {});
      p2.destroy();
    });

    // `loaded` resolves from the local replay, independent of any server.
    await p2.loaded;
    const restored = await waitForContent(ydoc2, "body", (t) => t === "secret offline data");
    expect(restored).toBe("secret offline data");
    // Confirm we genuinely never reached the server.
    expect(conn2.state.type).not.toBe("connected");
  });

  it("offline: loaded resolves from local storage even though synced never does", async () => {
    const docId = "doc-offline-loaded-vs-synced";
    const { make: makeStore } = createPersistentStoreFactory(true);

    // Seed local storage via a connected provider.
    const conn1 = createWsConnection();
    await conn1.connected;
    const p1 = new Provider({
      connection: conn1,
      document: docId,
      encryptionKey: key,
      enableOfflinePersistence: true,
      offlineStorage: makeStore(),
    });
    cleanups.push(() => {
      p1.transport.synced?.catch(() => {});
      p1.destroy();
    });
    await waitForSync(p1);
    p1.doc.getText("body").insert(0, "data while online");
    await waitUntil(
      async () => (await reconstructBody(makeStore(), docId, key)) === "data while online",
    );
    p1.destroy();
    await conn1.disconnect();

    bunServer.stop(true);

    const conn2 = createWsConnection({ connect: false });
    const ydoc2 = new Y.Doc();
    const p2 = new Provider({
      connection: conn2,
      document: docId,
      ydoc: ydoc2,
      encryptionKey: key,
      enableOfflinePersistence: true,
      offlineStorage: makeStore(),
    });
    cleanups.push(() => {
      p2.transport.synced?.catch(() => {});
      p2.destroy();
    });

    // loaded resolves and the doc is restored from local storage...
    await p2.loaded;
    const restored = await waitForContent(ydoc2, "body", (t) => t === "data while online");
    expect(restored).toBe("data while online");

    // ...but synced never resolves, since there is no server to sync with.
    const SYNCED_PENDING = Symbol("pending");
    const syncedResult = await Promise.race([
      p2.synced.then(() => "synced").catch(() => "errored"),
      new Promise((r) => setTimeout(() => r(SYNCED_PENDING), 200)),
    ]);
    expect(syncedResult).toBe(SYNCED_PENDING);
  });

  // --- Two-client sync ---

  it("two unencrypted clients sync a document over WebSocket", async () => {
    const docId = "doc-ws-2client";

    const { provider: pA } = await createProvider(docId);
    await waitForSync(pA);

    pA.doc.getText("body").insert(0, "hello from A");
    await new Promise((r) => setTimeout(r, 1));

    const { provider: pB } = await createProvider(docId);
    await waitForSync(pB);

    const text = await waitForContent(pB.doc, "body", (t) => t === "hello from A");
    expect(text).toBe("hello from A");

    pB.doc.getText("body").insert(text.length, " and B");
    const final = await waitForContent(pA.doc, "body", (t) => t === "hello from A and B");
    expect(final).toBe("hello from A and B");
  });

  // --- Encrypted two-client sync ---

  it("two encrypted clients sync a document over WebSocket", async () => {
    const docId = "doc-ws-enc-2client";

    const { provider: pA } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pA);

    pA.doc.getText("body").insert(0, "encrypted hello");
    await new Promise((r) => setTimeout(r, 1));

    const { provider: pB } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pB);

    const text = await waitForContent(pB.doc, "body", (t) => t === "encrypted hello");
    expect(text).toBe("encrypted hello");
  });

  it("encrypted bidirectional sync: both clients exchange live updates", async () => {
    const docId = "doc-ws-enc-bidi";

    const { provider: pA } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pA);

    pA.doc.getText("body").insert(0, "hello");
    await new Promise((r) => setTimeout(r, 1));

    const { provider: pB } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pB);
    await waitForContent(pB.doc, "body", (t) => t === "hello");

    pB.doc.getText("body").insert(5, " world");
    const textA = await waitForContent(pA.doc, "body", (t) => t === "hello world");
    expect(textA).toBe("hello world");

    pA.doc.getText("body").insert(11, "!");
    const textB = await waitForContent(pB.doc, "body", (t) => t === "hello world!");
    expect(textB).toBe("hello world!");
  });

  // --- Reconnection ---

  it("client reconnects after disconnect and resumes sync", async () => {
    const docId = "doc-ws-reconnect";

    const { provider: pA } = await createProvider(docId);
    await waitForSync(pA);

    pA.doc.getText("body").insert(0, "before disconnect");
    await new Promise((r) => setTimeout(r, 1));

    // Second client connects, syncs, disconnects, reconnects
    const conn2 = new Connection({
      transports: [websocketTransport()],
      url: baseUrl,
      connect: true,
      maxReconnectAttempts: 5,
      initialReconnectDelay: 100,
      maxBackoffTime: 500,
      batchIntervalMs: 0,
    });
    cleanups.push(() => conn2.destroy());
    await conn2.connected;

    const p2 = await Provider.create({
      connection: conn2,
      document: docId,
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      p2.transport.synced?.catch(() => {});
      p2.destroy();
    });
    await waitForSync(p2);
    await waitForContent(p2.doc, "body", (t) => t === "before disconnect");

    // Force disconnect the underlying WebSocket
    await conn2.disconnect();

    // Write to A while B is disconnected
    pA.doc.getText("body").insert(17, " + after");
    await new Promise((r) => setTimeout(r, 1));

    // Reconnect B
    await conn2.connect();
    await conn2.connected;

    const reconnectedText = await waitForContent(
      p2.doc,
      "body",
      (t) => t.includes("+ after"),
      10_000,
    );
    expect(reconnectedText).toBe("before disconnect + after");
  });

  // --- Encrypted reconnection ---

  it("encrypted client reconnects after disconnect and resumes sync", async () => {
    const docId = "doc-ws-enc-reconnect";

    // Client A connects with encryption
    const { provider: pA } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pA);

    // Client A writes content before B connects
    pA.doc.getText("body").insert(0, "before disconnect");
    await new Promise((r) => setTimeout(r, 1));

    // Client B connects with encryption and auto-reconnect enabled
    const conn2 = new Connection({
      transports: [websocketTransport()],
      url: baseUrl,
      connect: true,
      maxReconnectAttempts: 5,
      initialReconnectDelay: 100,
      maxBackoffTime: 500,
      batchIntervalMs: 0,
    });
    cleanups.push(() => conn2.destroy());
    await conn2.connected;

    const p2 = await Provider.create({
      connection: conn2,
      document: docId,
      encryptionKey: key,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      p2.transport.synced?.catch(() => {});
      p2.destroy();
    });
    await waitForSync(p2);
    await waitForContent(p2.doc, "body", (t) => t === "before disconnect");

    // Client B disconnects
    await conn2.disconnect();

    // Client A writes more content while B is disconnected
    pA.doc.getText("body").insert(17, " + after");
    await new Promise((r) => setTimeout(r, 1));

    // Client B reconnects
    await conn2.connect();
    await conn2.connected;

    // Client B should have all content (both before and after disconnect)
    const reconnectedText = await waitForContent(
      p2.doc,
      "body",
      (t) => t.includes("+ after"),
      10_000,
    );
    expect(reconnectedText).toBe("before disconnect + after");
  });

  // --- Server response timing ---

  it("server responds to sync-step-1 within timeout", async () => {
    const docId = "doc-ws-timing";
    const conn = createWsConnection();
    await conn.connected;

    const messagesReceived: Message[] = [];
    const reader = conn.getReader();
    // Consume the reader's source in the background
    (async () => {
      for await (const batch of reader.source) {
        for (const chunk of batch) {
          messagesReceived.push(chunk);
        }
      }
    })();

    const provider = await Provider.create({
      connection: conn,
      document: docId,
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      provider.transport.synced?.catch(() => {});
      provider.destroy();
    });

    // Wait up to 3s — server must respond with sync-step-2 and sync-step-1
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const hasStep2 = messagesReceived.some(
        (m) => m.type === "doc" && m.payload.type === "sync-step-2",
      );
      const hasStep1Response = messagesReceived.some(
        (m) => m.type === "doc" && m.payload.type === "sync-step-1",
      );
      if (hasStep2 && hasStep1Response) break;
      await new Promise((r) => setTimeout(r, 1));
    }

    const types = messagesReceived
      .filter((m) => m.type === "doc")
      .map((m) => (m as any).payload.type);

    expect(types).toContain("sync-step-2");
    expect(types).toContain("sync-step-1");
  });

  // --- Empty document sync ---

  it("client can sync an empty document without getting stuck", async () => {
    const docId = "doc-ws-empty";

    const { provider: p1 } = await createProvider(docId);
    await waitForSync(p1);

    const { provider: p2 } = await createProvider(docId);
    await waitForSync(p2);

    expect(p1.doc.getText("body").toString()).toBe("");
    expect(p2.doc.getText("body").toString()).toBe("");
  });

  it("encrypted client syncs empty document without hanging", async () => {
    const docId = "doc-ws-enc-empty";

    const { provider: p1 } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(p1);

    const { provider: p2 } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(p2);

    expect(p1.doc.getText("body").toString()).toBe("");
    expect(p2.doc.getText("body").toString()).toBe("");
  });

  // --- Rapid updates ---

  it("rapid successive edits all propagate to peer", async () => {
    const docId = "doc-ws-rapid";

    const { provider: pA } = await createProvider(docId);
    await waitForSync(pA);

    const { provider: pB } = await createProvider(docId);
    await waitForSync(pB);

    // Fire 20 rapid edits
    for (let i = 0; i < 20; i++) {
      pA.doc.getText("body").insert(pA.doc.getText("body").length, `${i} `);
    }

    const expected = Array.from({ length: 20 }, (_, i) => `${i} `).join("");
    const text = await waitForContent(pB.doc, "body", (t) => t === expected, 10_000);
    expect(text).toBe(expected);
  });

  // --- Multiple documents ---

  it("single connection handles multiple documents", async () => {
    const conn = createWsConnection();
    await conn.connected;

    const p1 = await Provider.create({
      connection: conn,
      document: "multi-doc-1",
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      p1.transport.synced?.catch(() => {});
      p1.destroy();
    });

    const p2 = await Provider.create({
      connection: conn,
      document: "multi-doc-2",
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      p2.transport.synced?.catch(() => {});
      p2.destroy();
    });

    await waitForSync(p1);
    await waitForSync(p2);

    p1.doc.getText("body").insert(0, "doc one");
    p2.doc.getText("body").insert(0, "doc two");

    await new Promise((r) => setTimeout(r, 1));

    // Verify via a second connection
    const conn2 = createWsConnection();
    await conn2.connected;

    const p1b = await Provider.create({
      connection: conn2,
      document: "multi-doc-1",
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      p1b.transport.synced?.catch(() => {});
      p1b.destroy();
    });

    const p2b = await Provider.create({
      connection: conn2,
      document: "multi-doc-2",
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      p2b.transport.synced?.catch(() => {});
      p2b.destroy();
    });

    await waitForSync(p1b);
    await waitForSync(p2b);

    const text1 = await waitForContent(p1b.doc, "body", (t) => t === "doc one");
    const text2 = await waitForContent(p2b.doc, "body", (t) => t === "doc two");

    expect(text1).toBe("doc one");
    expect(text2).toBe("doc two");
  });

  // --- Encrypted rapid updates ---

  it("rapid successive encrypted edits all propagate to peer", async () => {
    const docId = "doc-ws-enc-rapid";

    const { provider: pA } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pA);

    const { provider: pB } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pB);

    // Fire 20 rapid edits
    for (let i = 0; i < 20; i++) {
      pA.doc.getText("body").insert(pA.doc.getText("body").length, `${i} `);
    }

    const expected = Array.from({ length: 20 }, (_, i) => `${i} `).join("");
    const text = await waitForContent(pB.doc, "body", (t) => t === expected, 10_000);
    expect(text).toBe(expected);
  });

  // --- Encrypted multiple documents ---

  it("encrypted single connection handles multiple documents", async () => {
    const conn = createWsConnection();
    await conn.connected;

    const p1 = await Provider.create({
      connection: conn,
      document: "enc-multi-doc-1",
      encryptionKey: key,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      p1.transport.synced?.catch(() => {});
      p1.destroy();
    });

    const p2 = await Provider.create({
      connection: conn,
      document: "enc-multi-doc-2",
      encryptionKey: key,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      p2.transport.synced?.catch(() => {});
      p2.destroy();
    });

    await waitForSync(p1);
    await waitForSync(p2);

    p1.doc.getText("body").insert(0, "encrypted doc one");
    p2.doc.getText("body").insert(0, "encrypted doc two");

    await new Promise((r) => setTimeout(r, 1));

    // Verify via a second connection
    const conn2 = createWsConnection();
    await conn2.connected;

    const p1b = await Provider.create({
      connection: conn2,
      document: "enc-multi-doc-1",
      encryptionKey: key,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      p1b.transport.synced?.catch(() => {});
      p1b.destroy();
    });

    const p2b = await Provider.create({
      connection: conn2,
      document: "enc-multi-doc-2",
      encryptionKey: key,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      p2b.transport.synced?.catch(() => {});
      p2b.destroy();
    });

    await waitForSync(p1b);
    await waitForSync(p2b);

    const text1 = await waitForContent(p1b.doc, "body", (t) => t === "encrypted doc one");
    const text2 = await waitForContent(p2b.doc, "body", (t) => t === "encrypted doc two");

    expect(text1).toBe("encrypted doc one");
    expect(text2).toBe("encrypted doc two");
  });

  // --- Three encrypted clients converge ---

  it("three encrypted clients converge to same document state", async () => {
    const docId = "doc-ws-enc-3client";

    const { provider: pA } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pA);

    const { provider: pB } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pB);

    const { provider: pC } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pC);

    // Each client writes different content
    pA.doc.getText("body").insert(0, "AAA");
    pB.doc.getText("body").insert(0, "BBB");
    pC.doc.getText("body").insert(0, "CCC");

    // Wait for all three to converge - each should see all three contributions
    const predicate = (t: string) => t.includes("AAA") && t.includes("BBB") && t.includes("CCC");

    const textA = await waitForContent(pA.doc, "body", predicate, 10_000);
    const textB = await waitForContent(pB.doc, "body", predicate, 10_000);
    const textC = await waitForContent(pC.doc, "body", predicate, 10_000);

    // All three must have converged to the exact same state
    expect(textA).toBe(textB);
    expect(textB).toBe(textC);
    expect(textA).toContain("AAA");
    expect(textA).toContain("BBB");
    expect(textA).toContain("CCC");
  });

  // --- Connection state transitions ---

  it("connection reports correct state transitions", async () => {
    const states: string[] = [];
    const conn = new Connection({
      transports: [websocketTransport()],
      url: baseUrl,
      connect: false,
      maxReconnectAttempts: 0,
      batchIntervalMs: 0,
    });
    cleanups.push(() => conn.destroy());

    conn.on("update", (state) => {
      states.push(state.type);
    });

    expect(conn.state.type).toBe("disconnected");

    await conn.connect();
    await conn.connected;
    expect(conn.state.type).toBe("connected");

    await conn.disconnect();
    expect(conn.state.type).toBe("disconnected");

    expect(states).toContain("connecting");
    expect(states).toContain("connected");
    expect(states).toContain("disconnected");
  });

  // --- Encrypted integration: persistence, opacity, rich types ---

  function containsSubarray(haystack: Uint8Array, needle: Uint8Array): boolean {
    if (needle.length === 0) return true;
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  it("encrypted client writes and reads back after full provider teardown", async () => {
    const docId = "doc-ws-enc-persistence";

    const { provider: p1, connection: c1 } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(p1);

    p1.doc.getText("body").insert(0, "persisted secret");
    await new Promise((r) => setTimeout(r, 1));

    p1.destroy();
    await c1.disconnect();

    const { provider: p2 } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(p2);
    const restoredText = await waitForContent(p2.doc, "body", (t) => t === "persisted secret");

    expect(restoredText).toBe("persisted secret");
  });

  it("server storage does not contain plaintext user content", async () => {
    const docId = "doc-ws-enc-opacity";
    const secretText = "SUPER_SECRET_CONTENT_xyz123";

    const { provider: pA } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pA);

    pA.doc.getText("body").insert(0, secretText);

    // Poll until the update reaches server storage (key is namespaced as room/docId).
    // With merge-on-read, updates land in the pending log, not in the base state.
    const storageKey = `test/${docId}`;
    const deadline = Date.now() + 5000;
    let pending: import("../../storage/document-storage").PendingUpdate[] | null = null;
    while (Date.now() < deadline) {
      const list = MemoryDocumentStorage.pendingUpdates.get(storageKey);
      if (list && list.some((p) => p.sidecars.length > 0)) {
        pending = list;
        break;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(pending).not.toBeNull();
    if (!pending) throw new Error("unreachable");

    const secretBytes = new TextEncoder().encode(secretText);

    // Structure updates must not contain the plaintext
    for (const entry of pending) {
      expect(containsSubarray(new Uint8Array(entry.structureUpdate), secretBytes)).toBe(false);
    }

    // Encrypted sidecars must not contain the plaintext
    for (const entry of pending) {
      for (const sidecar of entry.sidecars) {
        expect(containsSubarray(new Uint8Array(sidecar.encrypted), secretBytes)).toBe(false);
      }
    }

    // Applying only the structure updates (without sidecars) must not reveal the text
    const stripped = new Y.Doc();
    for (const entry of pending) {
      Y.applyUpdateV2(stripped, entry.structureUpdate);
    }
    expect(stripped.getText("body").toString()).not.toBe(secretText);

    // But a client with the correct key can still read the content
    const { provider: pB } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pB);
    const text = await waitForContent(pB.doc, "body", (t) => t === secretText);
    expect(text).toBe(secretText);
  });

  it("rich Y.js content types survive encrypted sync", async () => {
    const docId = "doc-ws-enc-rich-types";

    const { provider: pA } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pA);

    // YMap with nested structure
    const settings = pA.doc.getMap("settings");
    settings.set("theme", "dark");
    settings.set("fontSize", 14);
    const nested = new Y.Map<string>();
    nested.set("key", "value");
    settings.set("nested", nested);

    // YArray
    pA.doc.getArray("items").push(["item1", "item2", "item3"]);

    // YText with formatting
    const body = pA.doc.getText("body");
    body.insert(0, "formatted text");
    body.format(0, 9, { bold: true });

    await new Promise((r) => setTimeout(r, 1));

    // New client with same key receives all content types
    const { provider: pB } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pB);
    await waitForContent(pB.doc, "body", (t) => t === "formatted text");

    expect(pB.doc.getMap("settings").get("theme")).toBe("dark");
    expect(pB.doc.getMap("settings").get("fontSize")).toBe(14);
    expect((pB.doc.getMap("settings").get("nested") as Y.Map<string>).get("key")).toBe("value");
    expect(pB.doc.getArray("items").toArray()).toEqual(["item1", "item2", "item3"]);

    const delta = pB.doc.getText("body").toDelta();
    expect(delta).toEqual([
      { insert: "formatted", attributes: { bold: true } },
      { insert: " text" },
    ]);
  });

  it("multiple incremental encrypted updates from multiple clients merge for late joiner", async () => {
    const docId = "doc-ws-enc-multi-incremental";

    const { provider: pA } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pA);

    pA.doc.getText("body").insert(0, "hello");
    await new Promise((r) => setTimeout(r, 1));

    const { provider: pB } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pB);
    await waitForContent(pB.doc, "body", (t) => t === "hello");

    pA.doc.getText("body").insert(5, " world");
    await waitForContent(pB.doc, "body", (t) => t === "hello world");

    pB.doc.getText("body").insert(11, "!!!");
    await waitForContent(pA.doc, "body", (t) => t.includes("!!!"));

    // Tear down both original clients
    pA.destroy();
    pB.destroy();

    // Late joiner must see all accumulated content from storage
    const { provider: pC } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(pC);
    const finalText = await waitForContent(
      pC.doc,
      "body",
      (t) => t.includes("hello") && t.includes("world") && t.includes("!!!"),
    );
    expect(finalText).toContain("hello");
    expect(finalText).toContain("world");
    expect(finalText).toContain("!!!");
  });

  it("encrypted content survives multiple disconnect/reconnect cycles with new providers", async () => {
    const docId = "doc-ws-enc-multi-lifecycle";

    // Round 1: write initial content
    const { provider: p1, connection: c1 } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(p1);
    p1.doc.getText("body").insert(0, "round1");
    await new Promise((r) => setTimeout(r, 1));
    p1.destroy();
    await c1.disconnect();

    // Round 2: new client reads previous content and appends
    const { provider: p2, connection: c2 } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(p2);
    await waitForContent(p2.doc, "body", (t) => t === "round1");
    p2.doc.getText("body").insert(6, " round2");
    await new Promise((r) => setTimeout(r, 1));
    p2.destroy();
    await c2.disconnect();

    // Round 3: verify all content accumulated correctly
    const { provider: p3 } = await createProvider(docId, {
      encryptionKey: key,
    });
    await waitForSync(p3);
    await waitForContent(p3.doc, "body", (t) => t === "round1 round2");
  });
});

// ─── Attribution e2e: encrypted vs unencrypted ──────────────────────────────

describe("attribution e2e: full WebSocket transport", () => {
  let pubSub: InMemoryPubSub;
  let server: Server<Ctx>;
  let key: CryptoKey;
  let bunServer: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const cleanups: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    MemoryDocumentStorage.attributionMaps.clear();
    pubSub = new InMemoryPubSub();
    key = await createEncryptionKey();

    server = new Server<Ctx>({
      storage: async (ctx) => {
        if (ctx.encrypted) {
          return new MemoryDocumentStorage(true);
        }
        return new MemoryDocumentStorage(false);
      },
      pubSub,
      rpcHandlers: {
        ...getAttributionRpcHandlers(),
      },
    });

    const ws = crossws({
      hooks: getWebsocketHandlers<Ctx>({
        server,
        onUpgrade: async () => ({
          context: { userId: "test-user", room: "test" },
        }),
      }),
    });

    bunServer = Bun.serve({
      port: 0,
      websocket: ws.websocket,
      async fetch(request, bunSrv) {
        if (request.headers.get("upgrade") === "websocket") {
          return ws.handleUpgrade(request, bunSrv);
        }
        return new Response("Not found", { status: 404 });
      },
    });

    baseUrl = `ws://localhost:${bunServer.port}`;
  });

  afterEach(async () => {
    // Bun does not isolate state between tests, so teardown must be ordered so
    // that no message reaches a torn-down client transport (which would surface
    // as a spurious "YDoc is destroyed" / closed-controller error in a later
    // test). First cut off the server so no new messages are broadcast...
    bunServer.stop(true);
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
    // ...then let any in-flight messages settle while clients are still alive...
    await new Promise((r) => setTimeout(r, 0));
    // ...and only then destroy the client providers/connections.
    for (const cleanup of cleanups.splice(0)) {
      try {
        await cleanup();
      } catch {
        // Best-effort teardown; ignore errors from already-closed resources.
      }
    }
  });

  function createWsConnection() {
    const conn = new Connection({
      transports: [websocketTransport()],
      url: baseUrl,
      connect: true,
      maxReconnectAttempts: 0,
      batchIntervalMs: 0,
    });
    cleanups.push(() => conn.destroy());
    return conn;
  }

  async function createProvider(
    document: string,
    opts?: { ydoc?: Y.Doc; encryptionKey?: CryptoKey | false },
  ) {
    const conn = createWsConnection();
    await conn.connected;
    const provider = await Provider.create({
      connection: conn,
      document,
      ydoc: opts?.ydoc,
      encryptionKey: opts?.encryptionKey ?? false,
      enableOfflinePersistence: false,
      rpc: {
        attribution: createAttributionRpc,
      },
    });
    cleanups.push(() => {
      provider.transport.synced?.catch(() => {});
      provider.destroy();
    });
    return { provider, connection: conn };
  }

  function waitForSync(provider: Provider<any, any>, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Sync timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (provider.transport.synced) {
        provider.transport.synced.then(() => {
          clearTimeout(timer);
          resolve();
        });
      } else {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * Poll `fn` until `predicate` holds, returning its result. Replaces fixed
   * sleeps when waiting for the server to persist attribution asynchronously,
   * so the tests stay deterministic under slow CI.
   */
  async function waitFor<T>(
    fn: () => Promise<T>,
    predicate: (value: T) => boolean,
    timeoutMs = 5000,
  ): Promise<T> {
    const start = Date.now();
    while (true) {
      const value = await fn();
      if (predicate(value)) return value;
      if (Date.now() - start > timeoutMs) return value;
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  it("unencrypted: getActivity returns attributed edits", async () => {
    const { provider } = await createProvider("attr-unenc");
    await waitForSync(provider);

    provider.doc.getText("body").insert(0, "hello world");

    const activity = await waitFor(
      () => provider.rpc.attribution.getActivity(),
      (a) => a.length > 0,
    );
    expect(activity.length).toBeGreaterThan(0);
    expect(activity[0].userId).toBe("test-user");
  });

  it("encrypted: getActivity returns attributed edits", async () => {
    const { provider } = await createProvider("attr-enc", { encryptionKey: key });
    await waitForSync(provider);

    provider.doc.getText("body").insert(0, "encrypted hello");

    const activity = await waitFor(
      () => provider.rpc.attribution.getActivity(),
      (a) => a.length > 0,
    );
    expect(activity.length).toBeGreaterThan(0);
    expect(activity[0].userId).toBe("test-user");
  });

  it("encrypted: getAttributionForRange resolves character-level authorship", async () => {
    const { provider } = await createProvider("attr-enc-range", { encryptionKey: key });
    await waitForSync(provider);

    provider.doc.getText("body").insert(0, "hello");

    const text = provider.doc.getText("body");
    const segments = await waitFor(
      () => {
        provider.rpc.attribution.invalidateCache();
        return provider.rpc.attribution.getForRange(text, 0, 5);
      },
      (s) => s.length > 0,
    );
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0].userId).toBe("test-user");
    expect(segments[0].from).toBe(0);
    expect(segments[0].to).toBe(5);
  });

  it("encrypted: getAttributionMap returns non-null ContentMap", async () => {
    const { provider } = await createProvider("attr-enc-map", { encryptionKey: key });
    await waitForSync(provider);

    provider.doc.getText("body").insert(0, "data");

    const map = await waitFor(
      () => provider.rpc.attribution.getMap(),
      (m) => m !== null && m.inserts.clients.size > 0,
    );
    expect(map).not.toBeNull();
    expect(map!.inserts.clients.size).toBeGreaterThan(0);
  });
});
