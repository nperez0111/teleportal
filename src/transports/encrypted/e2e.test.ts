import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import crossws from "crossws/adapters/bun";
import * as Y from "yjs";
import { createEncryptionKey } from "teleportal/encryption-key";
import { InMemoryPubSub, type Message, type ServerContext, type Update } from "teleportal";
import type {
  EncryptedStateVector,
  EncryptedSyncStep2,
  EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import { EncryptedMemoryStorage, YDocStorage } from "teleportal/storage";
import { Server } from "../../server/server";
import { Client } from "../../server/client";
import type { Session } from "../../server/session";
import { EncryptionClient } from "./client";
import { getWebsocketHandlers } from "../../websocket-server";
import { WebSocketConnection } from "../../providers/websocket/connection";
import { Provider } from "../../providers/provider";

type Ctx = ServerContext;

function createServerClient(id: string, onMessage: (msg: Message<Ctx>) => void): Client<Ctx> {
  const writable = new WritableStream<Message<Ctx>>({
    async write(chunk) {
      onMessage(chunk);
    },
  });
  return new Client<Ctx>({ id, writable });
}

// ─── Unit-level encrypted sync tests (no real transport) ───────────────────

describe("encrypted sync e2e: two clients via server", () => {
  let storage: EncryptedMemoryStorage;
  let pubSub: InMemoryPubSub;
  let server: Server<Ctx>;
  let key: CryptoKey;

  beforeEach(async () => {
    EncryptedMemoryStorage.docs.clear();
    storage = new EncryptedMemoryStorage();
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

    for (const msg of [...inbox]) {
      if (msg.type !== "doc") continue;
      if (msg.payload.type === "sync-step-2") {
        const compaction = await encClient.handleSyncStep2(
          msg.payload.update as unknown as EncryptedSyncStep2,
        );
        if (compaction) {
          inbox.length = 0;
          await session.apply(compaction as Message<Ctx>, serverClient);
        }
      } else if (msg.payload.type === "sync-step-1") {
        const resp = await encClient.handleSyncStep1(
          msg.payload.sv as unknown as EncryptedStateVector,
        );
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
    const update = Y.encodeStateAsUpdateV2(ydoc) as Update;
    const msg = await encClient.onUpdate(update);
    await session.apply(msg as Message<Ctx>, serverClient);
  }

  async function applyBroadcastedUpdates(encClient: EncryptionClient, inbox: Message<Ctx>[]) {
    for (const msg of inbox) {
      if (msg.type !== "doc") continue;
      if (msg.payload.type === "update") {
        await encClient.handleUpdate(msg.payload.update as unknown as EncryptedUpdatePayload);
      }
    }
  }

  it("client A writes, client B connects and receives the document", async () => {
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocA,
      key,
      snapshotIntervalMs: 0,
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
      snapshotIntervalMs: 0,
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
      snapshotIntervalMs: 0,
    });
    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocB,
      key,
      snapshotIntervalMs: 0,
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
      snapshotIntervalMs: 0,
    });
    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocB,
      key,
      snapshotIntervalMs: 0,
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
});

// ─── Full-stack WebSocket e2e tests ────────────────────────────────────────

describe("encrypted sync: snapshot ID mismatch", () => {
  let storage: EncryptedMemoryStorage;
  let pubSub: InMemoryPubSub;
  let server: Server<Ctx>;
  let key: CryptoKey;

  beforeEach(async () => {
    EncryptedMemoryStorage.docs.clear();
    storage = new EncryptedMemoryStorage();
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

  it("updates propagate even when receiver has a newer snapshot", async () => {
    const ydocA = new Y.Doc();
    const clientA = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocA,
      key,
      snapshotIntervalMs: 0,
    });
    const ydocB = new Y.Doc();
    const clientB = new EncryptionClient({
      document: "doc-1",
      ydoc: ydocB,
      key,
      snapshotIntervalMs: 0,
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

    // Both clients sync
    const syncStep1A = await clientA.start();
    await session.apply(syncStep1A as Message<Ctx>, serverClientA);
    for (const msg of [...inboxA]) {
      if (msg.type !== "doc") continue;
      if (msg.payload.type === "sync-step-2") {
        const compaction = await clientA.handleSyncStep2(
          msg.payload.update as unknown as EncryptedSyncStep2,
        );
        if (compaction) {
          inboxA.length = 0;
          await session.apply(compaction as Message<Ctx>, serverClientA);
        }
      } else if (msg.payload.type === "sync-step-1") {
        const resp = await clientA.handleSyncStep1(
          msg.payload.sv as unknown as EncryptedStateVector,
        );
        inboxA.length = 0;
        await session.apply(resp as Message<Ctx>, serverClientA);
      }
    }

    // Client A writes initial content
    ydocA.getText("body").insert(0, "base");
    const baseUpdate = Y.encodeStateAsUpdateV2(ydocA) as Update;
    const baseMsg = await clientA.onUpdate(baseUpdate);
    inboxA.length = 0;
    inboxB.length = 0;
    await session.apply(baseMsg as Message<Ctx>, serverClientA);

    // Client B connects and syncs
    session.addClient(serverClientB);
    const syncStep1B = await clientB.start();
    inboxB.length = 0;
    await session.apply(syncStep1B as Message<Ctx>, serverClientB);
    for (const msg of [...inboxB]) {
      if (msg.type !== "doc") continue;
      if (msg.payload.type === "sync-step-2") {
        const compaction = await clientB.handleSyncStep2(
          msg.payload.update as unknown as EncryptedSyncStep2,
        );
        if (compaction) {
          inboxB.length = 0;
          await session.apply(compaction as Message<Ctx>, serverClientB);
        }
      } else if (msg.payload.type === "sync-step-1") {
        const resp = await clientB.handleSyncStep1(
          msg.payload.sv as unknown as EncryptedStateVector,
        );
        inboxB.length = 0;
        await session.apply(resp as Message<Ctx>, serverClientB);
      }
    }
    expect(ydocB.getText("body").toString()).toBe("base");

    // Client B creates a NEW snapshot (simulating periodic compaction).
    // This changes B's activeSnapshotId, diverging it from A's.
    // The internal createSnapshotMessage method is private, so we trigger
    // it by calling handleSyncStep2 with a snapshot to force a new snapshot chain.
    // Instead, we can just directly call the public loadState with a new snapshot
    // by encoding B's current state as a fresh snapshot.
    const snapshotPayload = await clientB.encryptUpdate(Y.encodeStateAsUpdateV2(ydocB) as Update);
    await clientB.loadState({
      snapshot: {
        id: crypto.randomUUID(),
        parentSnapshotId: null,
        payload: snapshotPayload,
      },
    });

    // Now A and B have DIFFERENT snapshot IDs.
    // Client A writes — this update has A's old snapshot ID.
    ydocA.getText("body").insert(4, " updated");
    const updateAfterSnapshot = Y.encodeStateAsUpdateV2(ydocA) as Update;
    const updateMsg = await clientA.onUpdate(updateAfterSnapshot);
    inboxA.length = 0;
    inboxB.length = 0;
    await session.apply(updateMsg as Message<Ctx>, serverClientA);

    // Client B should receive and apply the update despite snapshot ID mismatch
    for (const msg of inboxB) {
      if (msg.type !== "doc") continue;
      if (msg.payload.type === "update") {
        await clientB.handleUpdate(msg.payload.update as unknown as EncryptedUpdatePayload);
      }
    }

    expect(ydocB.getText("body").toString()).toBe("base updated");

    clientA.destroy();
    clientB.destroy();
  });
});

describe("encrypted sync e2e: full WebSocket transport", () => {
  let pubSub: InMemoryPubSub;
  let server: Server<Ctx>;
  let key: CryptoKey;
  let bunServer: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const cleanups: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    EncryptedMemoryStorage.docs.clear();
    pubSub = new InMemoryPubSub();
    key = await createEncryptionKey();

    server = new Server<Ctx>({
      storage: async (ctx) => {
        if (ctx.encrypted) {
          return new EncryptedMemoryStorage();
        }
        return new YDocStorage();
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
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    bunServer.stop(true);
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  function createWsConnection(opts?: { connect?: boolean }) {
    const conn = new WebSocketConnection({
      url: baseUrl,
      connect: opts?.connect ?? true,
      maxReconnectAttempts: 0,
    });
    cleanups.push(() => conn.destroy());
    return conn;
  }

  async function createProvider(
    document: string,
    opts?: { ydoc?: Y.Doc; encryptionKey?: CryptoKey },
  ) {
    const conn = createWsConnection();
    await conn.connected;

    const provider = await Provider.create({
      connection: conn,
      document,
      ydoc: opts?.ydoc,
      encryptionKey: opts?.encryptionKey,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => provider.destroy());
    return { provider, connection: conn };
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
    await new Promise((r) => setTimeout(r, 200));

    p1.destroy();
    await c1.disconnect();

    const { provider: p2 } = await createProvider(docId);
    await waitForSync(p2);
    await new Promise((r) => setTimeout(r, 200));

    expect(p2.doc.getText("body").toString()).toBe("persisted text");
  });

  // --- Two-client sync ---

  it("two unencrypted clients sync a document over WebSocket", async () => {
    const docId = "doc-ws-2client";

    const { provider: pA } = await createProvider(docId);
    await waitForSync(pA);

    pA.doc.getText("body").insert(0, "hello from A");
    await new Promise((r) => setTimeout(r, 100));

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
    await new Promise((r) => setTimeout(r, 200));

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
    await new Promise((r) => setTimeout(r, 200));

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
    await new Promise((r) => setTimeout(r, 200));

    // Second client connects, syncs, disconnects, reconnects
    const conn2 = new WebSocketConnection({
      url: baseUrl,
      connect: true,
      maxReconnectAttempts: 5,
      initialReconnectDelay: 100,
      maxBackoffTime: 500,
    });
    cleanups.push(() => conn2.destroy());
    await conn2.connected;

    const p2 = await Provider.create({
      connection: conn2,
      document: docId,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => p2.destroy());
    await waitForSync(p2);
    await waitForContent(p2.doc, "body", (t) => t === "before disconnect");

    // Force disconnect the underlying WebSocket
    await conn2.disconnect();

    // Write to A while B is disconnected
    pA.doc.getText("body").insert(17, " + after");
    await new Promise((r) => setTimeout(r, 200));

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

  // --- Server response timing ---

  it("server responds to sync-step-1 within timeout", async () => {
    const docId = "doc-ws-timing";
    const conn = createWsConnection();
    await conn.connected;

    const messagesReceived: Message[] = [];
    const reader = conn.getReader();
    reader.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          messagesReceived.push(chunk);
        },
      }),
    );

    const provider = await Provider.create({
      connection: conn,
      document: docId,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => provider.destroy());

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
      await new Promise((r) => setTimeout(r, 50));
    }

    const types = messagesReceived
      .filter((m) => m.type === "doc")
      .map((m) => (m as any).payload.type);

    expect(types).toContain("sync-step-2");
    expect(types).toContain("sync-step-1");
  });

  // --- No-op update doesn't hang ---

  it("client can sync an empty document without getting stuck", async () => {
    const docId = "doc-ws-empty";

    const { provider: p1 } = await createProvider(docId);
    await waitForSync(p1);

    // Just syncing an empty doc should complete without hanging
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

  // --- Rapid updates don't hang ---

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
      enableOfflinePersistence: false,
    });
    cleanups.push(() => p1.destroy());

    const p2 = await Provider.create({
      connection: conn,
      document: "multi-doc-2",
      enableOfflinePersistence: false,
    });
    cleanups.push(() => p2.destroy());

    await waitForSync(p1);
    await waitForSync(p2);

    p1.doc.getText("body").insert(0, "doc one");
    p2.doc.getText("body").insert(0, "doc two");

    await new Promise((r) => setTimeout(r, 200));

    // Verify via a second connection
    const conn2 = createWsConnection();
    await conn2.connected;

    const p1b = await Provider.create({
      connection: conn2,
      document: "multi-doc-1",
      enableOfflinePersistence: false,
    });
    cleanups.push(() => p1b.destroy());

    const p2b = await Provider.create({
      connection: conn2,
      document: "multi-doc-2",
      enableOfflinePersistence: false,
    });
    cleanups.push(() => p2b.destroy());

    await waitForSync(p1b);
    await waitForSync(p2b);

    const text1 = await waitForContent(p1b.doc, "body", (t) => t === "doc one");
    const text2 = await waitForContent(p2b.doc, "body", (t) => t === "doc two");

    expect(text1).toBe("doc one");
    expect(text2).toBe("doc two");
  });

  // --- Connection state transitions ---

  it("connection reports correct state transitions", async () => {
    const states: string[] = [];
    const conn = new WebSocketConnection({
      url: baseUrl,
      connect: false,
      maxReconnectAttempts: 0,
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
});
