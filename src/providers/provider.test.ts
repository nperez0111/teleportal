import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { DocMessage, PresenceMessage, RpcMessage } from "teleportal";
import { createEncryptionKey } from "teleportal/encryption-key";
import { encodeContentEncryptedPayload } from "teleportal/protocol/encryption";
import { MemoryDocumentStorage } from "../storage/in-memory/document-storage";
import { DirectConnection as Connection } from "./connection";
import { Provider, teleportalEventClient } from "./provider";
import { createMemoryTransportPair } from "./transports/memory";
import type { RpcExtension, RpcExtensionContext } from "./rpc-extension";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a connected provider backed by an in-memory transport pair. */
async function createTestProvider(options?: {
  rpc?: Record<string, () => RpcExtension<any>>;
  ydoc?: Y.Doc;
  awareness?: Awareness;
  /** Defaults to `false` (plaintext) since most mechanics tests don't need crypto. */
  encryptionKey?: CryptoKey | false;
}) {
  const [clientTransport, serverTransport] = createMemoryTransportPair();
  const clientConn = new Connection({
    transports: [clientTransport],
    connect: false,
    batchIntervalMs: 0,
  });
  const serverConn = new Connection({
    transports: [serverTransport],
    connect: false,
    batchIntervalMs: 0,
  });

  await Promise.all([clientConn.connect(), serverConn.connect()]);

  const provider = new Provider({
    connection: clientConn,
    document: "test-doc",
    enableOfflinePersistence: false,
    rpc: options?.rpc ?? {},
    ydoc: options?.ydoc,
    awareness: options?.awareness,
    encryptionKey: options?.encryptionKey ?? false,
  });

  return { provider, clientConn, serverConn, clientTransport, serverTransport };
}

/** Create a mock RPC extension for testing. */
function createMockRpc() {
  let ctx: RpcExtensionContext | null = null;
  let destroyed = false;
  const handledMessages: any[] = [];

  const extension: RpcExtension<{
    ping(): string;
    getCtx(): RpcExtensionContext | null;
  }> = {
    create(c) {
      ctx = c;
      return {
        ping: () => "pong",
        getCtx: () => ctx,
      };
    },
    destroy() {
      destroyed = true;
    },
    handleMessage(msg) {
      handledMessages.push(msg);
      return true;
    },
    handleAck(msg) {
      handledMessages.push(msg);
      return true;
    },
  };

  return {
    factory: () => extension,
    isDestroyed: () => destroyed,
    handledMessages,
    getCtx: () => ctx,
  };
}

/** Wait for queued microtasks / timers to flush. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * Send a sync-done message from the server connection so that
 * the client provider's transport.synced promise can resolve.
 */
async function sendSyncDone(serverConn: Connection, document: string) {
  const syncDone = new DocMessage(document, { type: "sync-done" }, {}, false);
  await serverConn.send(syncDone);
  await flush();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Provider", () => {
  // -----------------------------------------------------------------------
  // 1. Provider Construction and Lifecycle
  // -----------------------------------------------------------------------
  describe("construction and lifecycle", () => {
    it("creates with default ydoc and awareness when not provided", async () => {
      const { provider } = await createTestProvider();

      expect(provider.doc).toBeInstanceOf(Y.Doc);
      expect(provider.awareness).toBeInstanceOf(Awareness);
      expect(provider.document).toBe("test-doc");

      provider.destroy();
    });

    it("creates with custom ydoc and awareness", async () => {
      const { provider } = await createTestProvider({
        ydoc: new Y.Doc(),
        awareness: undefined,
      });

      expect(provider.doc).toBeInstanceOf(Y.Doc);
      expect(provider.awareness).toBeInstanceOf(Awareness);

      provider.destroy();
    });

    it("creates with explicitly provided ydoc and awareness", async () => {
      const ydoc = new Y.Doc();
      const awareness = new Awareness(ydoc);
      const { provider } = await createTestProvider({ ydoc, awareness });

      expect(provider.doc).toBe(ydoc);
      expect(provider.awareness).toBe(awareness);

      provider.destroy();
    });

    it("destroys cleanly (connection, doc, transport)", async () => {
      const { provider, clientConn } = await createTestProvider();
      expect(clientConn.destroyed).toBe(false);

      provider.destroy();
      await flush();

      // Default destroyConnection=true means connection is also destroyed
      expect(clientConn.destroyed).toBe(true);
    });

    it("destroys without destroying connection when destroyConnection: false", async () => {
      const { provider, clientConn, serverConn } = await createTestProvider();

      provider.destroy({ destroyConnection: false });
      await flush();

      expect(clientConn.destroyed).toBe(false);

      // Clean up
      await clientConn.destroy();
      await serverConn.destroy();
    });

    it("destroys without destroying doc when destroyDoc: false", async () => {
      const ydoc = new Y.Doc();
      const { provider } = await createTestProvider({ ydoc });

      let docDestroyed = false;
      ydoc.on("destroy", () => {
        docDestroyed = true;
      });

      provider.destroy({ destroyDoc: false });
      await flush();

      expect(docDestroyed).toBe(false);

      ydoc.destroy();
    });

    it("[Symbol.dispose] works", async () => {
      const { provider, clientConn } = await createTestProvider();

      provider[Symbol.dispose]();
      await flush();

      expect(clientConn.destroyed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Provider Events
  // -----------------------------------------------------------------------
  describe("events", () => {
    it("emits connected event when connection connects", async () => {
      const [clientTransport, serverTransport] = createMemoryTransportPair();
      const clientConn = new Connection({
        transports: [clientTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      const serverConn = new Connection({
        transports: [serverTransport],
        connect: false,
        batchIntervalMs: 0,
      });

      // Create provider while disconnected
      const provider = new Provider({
        connection: clientConn,
        document: "test-doc",
        enableOfflinePersistence: false,
        rpc: {},
        encryptionKey: false,
      });

      let connectedFired = false;
      provider.on("connected", () => {
        connectedFired = true;
      });

      // Now connect
      await Promise.all([clientConn.connect(), serverConn.connect()]);
      await flush();

      expect(connectedFired).toBe(true);

      provider.destroy();
      await serverConn.destroy();
    });

    it("emits disconnected event when connection disconnects", async () => {
      const { provider, clientConn, serverConn, clientTransport } = await createTestProvider();

      let disconnectedFired = false;
      provider.on("disconnected", () => {
        disconnectedFired = true;
      });

      clientTransport.simulateDisconnect();
      await flush();

      expect(disconnectedFired).toBe(true);

      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });

    it("emits update event when connection state changes", async () => {
      const [clientTransport, serverTransport] = createMemoryTransportPair();
      const clientConn = new Connection({
        transports: [clientTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      const serverConn = new Connection({
        transports: [serverTransport],
        connect: false,
        batchIntervalMs: 0,
      });

      const provider = new Provider({
        connection: clientConn,
        document: "test-doc",
        enableOfflinePersistence: false,
        rpc: {},
        encryptionKey: false,
      });

      const states: string[] = [];
      provider.on("update", (state) => {
        states.push(state.type);
      });

      await Promise.all([clientConn.connect(), serverConn.connect()]);
      await flush();

      // Should have seen connecting -> connected
      expect(states).toContain("connecting");
      expect(states).toContain("connected");

      provider.destroy();
      await serverConn.destroy();
    });

    it("emits received-message event", async () => {
      const { provider, serverConn } = await createTestProvider();

      const receivedMessages: any[] = [];
      provider.on("received-message", (msg) => {
        receivedMessages.push(msg);
      });

      // Send a presence-join from server to client
      const presenceMsg = new PresenceMessage("test-doc", {
        type: "presence-join",
        awarenessId: 42,
        clientId: "client-1",
        userId: "user-1",
        data: { name: "Alice" },
      });
      await serverConn.send(presenceMsg);
      await flush();

      expect(receivedMessages.length).toBeGreaterThanOrEqual(1);

      provider.destroy();
      await serverConn.destroy();
    });

    it("keeps received file-chunk stream messages off the devtools event pipeline", async () => {
      const { provider, serverConn } = await createTestProvider();

      const devtoolsMessages: any[] = [];
      const providerMessages: any[] = [];
      const unsubscribe = teleportalEventClient.on(
        "teleportal-provider:received-message",
        (event) => devtoolsMessages.push(event.payload.message),
      );
      provider.on("received-message", (msg) => providerMessages.push(msg));

      const streamMsg = new RpcMessage(
        "test-doc",
        {
          type: "success",
          payload: {
            fileId: "file-1",
            chunkIndex: 0,
            chunkData: new Uint8Array([1, 2, 3]),
            merkleProof: [],
            totalChunks: 1,
            bytesUploaded: 3,
            encrypted: false,
          },
        },
        "fileDownload",
        "stream",
        "req-1",
      );
      const responseMsg = new RpcMessage(
        "test-doc",
        { type: "success", payload: { fileId: "file-1" } },
        "fileDownload",
        "response",
        "req-1",
      );
      await serverConn.send(streamMsg);
      await serverConn.send(responseMsg);
      await flush();

      // The provider's own event still carries every message (extensions need
      // the chunks); only the devtools observation pipeline skips them.
      expect(providerMessages.some((m) => m.type === "rpc" && m.requestType === "stream")).toBe(
        true,
      );
      expect(devtoolsMessages.some((m) => m.type === "rpc" && m.requestType === "stream")).toBe(
        false,
      );
      expect(devtoolsMessages.some((m) => m.type === "rpc" && m.requestType === "response")).toBe(
        true,
      );

      unsubscribe();
      provider.destroy();
      await serverConn.destroy();
    });

    it("emits sent-message event", async () => {
      const { provider } = await createTestProvider();

      const sentMessages: any[] = [];
      provider.on("sent-message", (msg) => {
        sentMessages.push(msg);
      });

      // The provider sends a sync-step-1 + presence-announce on init,
      // which should trigger sent-message events
      await flush();

      // Provider auto-sends messages on connect (sync-step-1, presence-announce)
      expect(sentMessages.length).toBeGreaterThanOrEqual(1);

      provider.destroy();
    });

    it("emits all events correctly during lifecycle", async () => {
      const [clientTransport, serverTransport] = createMemoryTransportPair();
      const clientConn = new Connection({
        transports: [clientTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      const serverConn = new Connection({
        transports: [serverTransport],
        connect: false,
        batchIntervalMs: 0,
      });

      const provider = new Provider({
        connection: clientConn,
        document: "test-doc",
        enableOfflinePersistence: false,
        rpc: {},
        encryptionKey: false,
      });

      const events: string[] = [];
      provider.on("connected", () => events.push("connected"));
      provider.on("disconnected", () => events.push("disconnected"));
      provider.on("update", (state) => events.push(`update:${state.type}`));

      // Connect
      await Promise.all([clientConn.connect(), serverConn.connect()]);
      await flush();

      // Disconnect
      clientTransport.simulateDisconnect();
      await flush();

      expect(events).toContain("connected");
      expect(events).toContain("disconnected");
      expect(events).toContain("update:connected");
      expect(events).toContain("update:disconnected");

      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 3. Synced Promise
  // -----------------------------------------------------------------------
  describe("synced promise", () => {
    it("resolves when connected + transport synced + no in-flight messages", async () => {
      const { provider, serverConn } = await createTestProvider();

      // Send sync-done from server so transport.synced resolves
      await sendSyncDone(serverConn, "test-doc");

      const synced = provider.synced;
      expect(synced).toBeInstanceOf(Promise);

      // Should resolve without hanging
      await synced;

      provider.destroy();
      await serverConn.destroy();
    });

    it("invalidates when connection disconnects", async () => {
      const { provider, clientConn, serverConn, clientTransport } = await createTestProvider();

      // Resolve synced first
      await sendSyncDone(serverConn, "test-doc");
      const synced1 = provider.synced;
      await synced1;

      // Disconnect to invalidate
      clientTransport.simulateDisconnect();
      await flush();

      // After disconnect, synced should be a new promise (not the cached one)
      const synced2 = provider.synced;
      expect(synced2).not.toBe(synced1);

      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 4. RPC Extension System
  // -----------------------------------------------------------------------
  describe("RPC extension system", () => {
    it("initializes extensions during construction", async () => {
      const mock = createMockRpc();
      const { provider } = await createTestProvider({
        rpc: { myExt: mock.factory },
      });

      // Extension should have been created — ctx should be set
      expect(mock.getCtx()).not.toBeNull();

      provider.destroy();
    });

    it("provides correct RpcExtensionContext", async () => {
      const mock = createMockRpc();
      const ydoc = new Y.Doc();
      const awareness = new Awareness(ydoc);
      const { provider } = await createTestProvider({
        rpc: { myExt: mock.factory },
        ydoc,
        awareness,
      });

      const ctx = mock.getCtx()!;
      expect(ctx).not.toBeNull();
      expect(ctx.document).toBe("test-doc");
      expect(ctx.doc).toBe(ydoc);
      expect(ctx.awareness).toBe(awareness);
      expect(ctx.rpcClient).toBeDefined();
      expect(ctx.connection).toBeDefined();
      // ctx.synced mirrors provider.synced, which is rejectable (e.g. the
      // transport's synced rejects on destroy). Swallow it here so teardown
      // doesn't surface as an unhandled rejection.
      const syncedPromise = ctx.synced;
      expect(syncedPromise).toBeInstanceOf(Promise);
      syncedPromise.catch(() => {});

      provider.destroy();
    });

    it("exposes extension API under .rpc namespace", async () => {
      const mock = createMockRpc();
      const { provider } = await createTestProvider({
        rpc: { myExt: mock.factory },
      });

      expect(provider.rpc.myExt).toBeDefined();
      expect(provider.rpc.myExt.ping()).toBe("pong");

      provider.destroy();
    });

    it("routes RPC messages to extension handleMessage", async () => {
      const mock = createMockRpc();
      const { provider, serverConn } = await createTestProvider({
        rpc: { myExt: mock.factory },
      });

      // Send an RPC request message from server (request type does not need originalRequestId)
      const rpcMsg = new RpcMessage(
        "test-doc",
        { type: "success", payload: { method: "test" } },
        "test",
        "request",
        undefined,
      );
      await serverConn.send(rpcMsg);
      await flush();

      const rpcMessages = mock.handledMessages.filter((m: any) => m.type === "rpc");
      expect(rpcMessages.length).toBeGreaterThanOrEqual(1);

      provider.destroy();
      await serverConn.destroy();
    });

    it("routes ACK messages to extension handleAck", async () => {
      const mock = createMockRpc();
      const { provider, clientConn, serverConn } = await createTestProvider({
        rpc: { myExt: mock.factory },
      });

      // First, we need a message "in flight" from the client, then the server acks it.
      // But ACK routing to extensions happens on received-message for ack type.
      // The connection itself also handles acks. The extension gets it too via the
      // separate received-message listener in provider.

      // We can directly simulate by sending a presence-join from client to server,
      // and then the server will auto-ack it. When the client receives the ack,
      // the extension should handle it.
      // But it's simpler to just check that ack messages flow through.

      // Clear tracked messages
      mock.handledMessages.length = 0;

      // Send a presence-join from server side which doesn't produce an ack
      // Instead, send a regular doc message from server, which causes the client
      // connection to auto-send an ack back. But we want the _client_ to receive
      // an ack from the _server_.

      // Simplest approach: send a doc message from client, which the server will ack.
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "hello");
      const update = Y.encodeStateAsUpdateV2(doc);
      const docMsg = new DocMessage(
        "test-doc",
        { type: "update", update: { version: 2, data: update as any } },
        {},
        false,
      );
      await clientConn.send(docMsg);
      await flush();

      // The server connection auto-acks non-ack messages. So the client should
      // receive an ack, which should be routed to the extension.
      const ackMessages = mock.handledMessages.filter((m: any) => m.type === "ack");
      expect(ackMessages.length).toBeGreaterThanOrEqual(1);

      provider.destroy();
      await serverConn.destroy();
      doc.destroy();
    });

    it("calls extension destroy on provider destroy", async () => {
      const mock = createMockRpc();
      const { provider } = await createTestProvider({
        rpc: { myExt: mock.factory },
      });

      expect(mock.isDestroyed()).toBe(false);

      provider.destroy();
      await flush();

      expect(mock.isDestroyed()).toBe(true);
    });

    it("works with no extensions (rpc: {})", async () => {
      const { provider } = await createTestProvider({ rpc: {} });

      expect(provider.rpc).toBeDefined();
      expect(Object.keys(provider.rpc)).toHaveLength(0);

      provider.destroy();
    });

    it("supports multiple extensions", async () => {
      const mock1 = createMockRpc();
      const mock2 = createMockRpc();
      const { provider } = await createTestProvider({
        rpc: {
          ext1: mock1.factory,
          ext2: mock2.factory,
        },
      });

      expect(provider.rpc.ext1.ping()).toBe("pong");
      expect(provider.rpc.ext2.ping()).toBe("pong");

      provider.destroy();
      await flush();

      expect(mock1.isDestroyed()).toBe(true);
      expect(mock2.isDestroyed()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Presence Events
  // -----------------------------------------------------------------------
  describe("presence events", () => {
    it("emits peer-join on presence-join message", async () => {
      const { provider, serverConn } = await createTestProvider();

      let joinEvent: any = null;
      provider.on("peer-join", (peer) => {
        joinEvent = peer;
      });

      const joinMsg = new PresenceMessage("test-doc", {
        type: "presence-join",
        awarenessId: 42,
        clientId: "client-1",
        userId: "user-1",
        data: { name: "Alice" },
      });
      await serverConn.send(joinMsg);
      await flush();

      expect(joinEvent).not.toBeNull();
      expect(joinEvent.awarenessId).toBe(42);
      expect(joinEvent.clientId).toBe("client-1");
      expect(joinEvent.userId).toBe("user-1");
      expect(joinEvent.data).toEqual({ name: "Alice" });

      provider.destroy();
      await serverConn.destroy();
    });

    it("emits peer-leave on presence-leave message and clears awareness", async () => {
      const { provider, serverConn } = await createTestProvider();

      let leaveEvent: any = null;
      provider.on("peer-leave", (peer) => {
        leaveEvent = peer;
      });

      // Seed an awareness state for the peer so the leave can actually clear it.
      provider.awareness.states.set(42, { name: "Alice" });
      expect(provider.awareness.getStates().has(42)).toBe(true);

      const leaveMsg = new PresenceMessage("test-doc", {
        type: "presence-leave",
        awarenessId: 42,
        clientId: "client-1",
        userId: "user-1",
        data: { name: "Alice" },
      });
      await serverConn.send(leaveMsg);
      await flush();

      expect(leaveEvent).not.toBeNull();
      expect(leaveEvent.awarenessId).toBe(42);
      expect(leaveEvent.clientId).toBe("client-1");
      expect(leaveEvent.userId).toBe("user-1");
      expect(leaveEvent.data).toEqual({ name: "Alice" });

      // Awareness state for that client should be cleared
      const states = provider.awareness.getStates();
      expect(states.has(42)).toBe(false);

      provider.destroy();
      await serverConn.destroy();
    });

    it("ignores presence-announce (client-to-server only)", async () => {
      const { provider, serverConn } = await createTestProvider();

      let joinFired = false;
      let leaveFired = false;
      provider.on("peer-join", () => {
        joinFired = true;
      });
      provider.on("peer-leave", () => {
        leaveFired = true;
      });

      const announceMsg = new PresenceMessage("test-doc", {
        type: "presence-announce",
        awarenessId: 99,
      });
      await serverConn.send(announceMsg);
      await flush();

      expect(joinFired).toBe(false);
      expect(leaveFired).toBe(false);

      provider.destroy();
      await serverConn.destroy();
    });

    it("ignores presence-heartbeat", async () => {
      const { provider, serverConn } = await createTestProvider();

      let joinFired = false;
      let leaveFired = false;
      provider.on("peer-join", () => {
        joinFired = true;
      });
      provider.on("peer-leave", () => {
        leaveFired = true;
      });

      const heartbeatMsg = new PresenceMessage("test-doc", {
        type: "presence-heartbeat",
        clients: [
          {
            awarenessId: 1,
            clientId: "c-1",
            userId: "u-1",
            data: {},
          },
        ],
      });
      await serverConn.send(heartbeatMsg);
      await flush();

      expect(joinFired).toBe(false);
      expect(leaveFired).toBe(false);

      provider.destroy();
      await serverConn.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 6. Provider.create() static factory
  // -----------------------------------------------------------------------
  describe("Provider.create() static factory", () => {
    it("creates with connection option", async () => {
      const [clientTransport, serverTransport] = createMemoryTransportPair();
      const clientConn = new Connection({
        transports: [clientTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      const serverConn = new Connection({
        transports: [serverTransport],
        connect: false,
        batchIntervalMs: 0,
      });

      await Promise.all([clientConn.connect(), serverConn.connect()]);

      const provider = await Provider.create({
        connection: clientConn,
        document: "factory-doc",
        enableOfflinePersistence: false,
        encryptionKey: false,
      });

      expect(provider).toBeInstanceOf(Provider);
      expect(provider.document).toBe("factory-doc");
      expect(provider.connection).toBe(clientConn);

      await flush();
      provider.destroy();
      await serverConn.destroy();
    });

    it("awaits connection.connected before returning", async () => {
      const [clientTransport, serverTransport] = createMemoryTransportPair();
      const clientConn = new Connection({
        transports: [clientTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      const serverConn = new Connection({
        transports: [serverTransport],
        connect: false,
        batchIntervalMs: 0,
      });

      // Start connection + factory concurrently
      const connectPromise = Promise.all([clientConn.connect(), serverConn.connect()]);

      const providerPromise = Provider.create({
        connection: clientConn,
        document: "factory-doc",
        enableOfflinePersistence: false,
        encryptionKey: false,
      });

      await connectPromise;
      const provider = await providerPromise;

      expect(provider.state.type).toBe("connected");

      // Let any async init (sync-step-1, presence-announce) settle before destroying
      await flush();

      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 7. switchDocument and openDocument
  // -----------------------------------------------------------------------
  describe("switchDocument and openDocument", () => {
    it("switchDocument destroys current provider but preserves connection", async () => {
      const { provider, clientConn, serverConn } = await createTestProvider();

      const oldDoc = provider.doc;
      let oldDocDestroyed = false;
      oldDoc.on("destroy", () => {
        oldDocDestroyed = true;
      });

      const newProvider = provider.switchDocument({
        document: "new-doc",
        enableOfflinePersistence: false,
      });

      await flush();

      expect(newProvider).toBeInstanceOf(Provider);
      expect(newProvider.document).toBe("new-doc");
      // Connection should still be alive (not destroyed)
      expect(clientConn.destroyed).toBe(false);
      // Old doc should be destroyed
      expect(oldDocDestroyed).toBe(true);
      // New provider has a different doc
      expect(newProvider.doc).not.toBe(oldDoc);

      newProvider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });

    it("openDocument creates new provider sharing connection", async () => {
      const { provider, clientConn, serverConn } = await createTestProvider();

      const newProvider = provider.openDocument({
        document: "second-doc",
        enableOfflinePersistence: false,
      });

      await flush();

      expect(newProvider).toBeInstanceOf(Provider);
      expect(newProvider.document).toBe("second-doc");
      // Original provider should still be alive
      expect(provider.document).toBe("test-doc");
      // Both share the same connection
      expect(newProvider.connection).toBe(clientConn);
      expect(provider.connection).toBe(clientConn);
      // New provider has its own doc
      expect(newProvider.doc).not.toBe(provider.doc);

      newProvider.destroy({ destroyConnection: false });
      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });

    it("openDocument inherits rpc config", async () => {
      const mock = createMockRpc();
      const { provider, clientConn, serverConn } = await createTestProvider({
        rpc: { myExt: mock.factory },
      });

      const newProvider = provider.openDocument({
        document: "inherited-doc",
        enableOfflinePersistence: false,
      });

      await flush();

      // Should also have the rpc extension
      expect(newProvider.rpc.myExt).toBeDefined();
      expect(newProvider.rpc.myExt.ping()).toBe("pong");

      newProvider.destroy({ destroyConnection: false });
      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 8. Public getters
  // -----------------------------------------------------------------------
  describe("public getters", () => {
    it("state reflects connection state", async () => {
      const { provider, clientConn, serverConn, clientTransport } = await createTestProvider();

      expect(provider.state.type).toBe("connected");

      clientTransport.simulateDisconnect();
      await flush();

      expect(provider.state.type).toBe("disconnected");

      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });

    it("connection returns the underlying connection", async () => {
      const { provider, clientConn } = await createTestProvider();

      expect(provider.connection).toBe(clientConn);

      provider.destroy();
    });

    it("transport is defined", async () => {
      const { provider } = await createTestProvider();

      expect(provider.transport).toBeDefined();
      expect(provider.transport.source).toBeDefined();
      expect(typeof provider.transport.write).toBe("function");
      expect(typeof provider.transport.close).toBe("function");

      provider.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 9. Destroy idempotence
  // -----------------------------------------------------------------------
  describe("destroy idempotence", () => {
    it("calling destroy multiple times does not throw", async () => {
      const { provider } = await createTestProvider();

      expect(() => {
        provider.destroy();
        provider.destroy();
      }).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // 10. Encryption is the default
  // -----------------------------------------------------------------------
  describe("encryption default", () => {
    /** Capture the encryption flag of the first sync-step-1 doc message. */
    async function firstDocMessageEncrypted(provider: Provider): Promise<boolean> {
      const sent: DocMessage<any>[] = [];
      provider.on("sent-message", (msg) => {
        if (msg instanceof DocMessage) sent.push(msg);
      });
      await flush();
      expect(sent.length).toBeGreaterThanOrEqual(1);
      return sent[0].encrypted;
    }

    it("throws when constructed without an encryptionKey", async () => {
      const [clientTransport] = createMemoryTransportPair();
      const clientConn = new Connection({
        transports: [clientTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      expect(
        // Omitting encryptionKey is type-valid (the field is optional) but
        // throws at runtime — that's the loud-by-default behavior under test.
        () => new Provider({ connection: clientConn, document: "test-doc" }),
      ).toThrow(/encryptionKey/);
      await clientConn.destroy();
    });

    it("opts out of encryption with encryptionKey: false (plaintext messages)", async () => {
      const { provider, clientConn, serverConn } = await createTestProvider({
        encryptionKey: false,
      });
      expect(await firstDocMessageEncrypted(provider)).toBe(false);
      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });

    it("sends encrypted messages when given a key", async () => {
      const key = await createEncryptionKey();
      const { provider, clientConn, serverConn } = await createTestProvider({
        encryptionKey: key,
      });
      expect(await firstDocMessageEncrypted(provider)).toBe(true);
      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });

    it("openDocument inherits the parent's key by default", async () => {
      const key = await createEncryptionKey();
      const { provider, clientConn, serverConn } = await createTestProvider({
        encryptionKey: key,
      });
      const child = provider.openDocument({
        document: "child-doc",
        enableOfflinePersistence: false,
      });
      expect(child.encryptionKey).toBe(key);
      await flush();
      child.destroy({ destroyConnection: false });
      provider.destroy({ destroyConnection: false });
      await flush();
      await clientConn.destroy();
      await serverConn.destroy();
    });

    it("openDocument can override an inherited key with false, and vice versa", async () => {
      const key = await createEncryptionKey();
      const { provider, clientConn, serverConn } = await createTestProvider({
        encryptionKey: key,
      });
      // Encrypted parent -> explicit plaintext child.
      const plaintextChild = provider.openDocument({
        document: "plaintext-child",
        enableOfflinePersistence: false,
        encryptionKey: false,
      });
      expect(plaintextChild.encryptionKey).toBe(false);

      // Plaintext provider -> encrypted child.
      const {
        provider: plaintextProvider,
        clientConn: clientConn2,
        serverConn: serverConn2,
      } = await createTestProvider({ encryptionKey: false });
      const encryptedChild = plaintextProvider.openDocument({
        document: "encrypted-child",
        enableOfflinePersistence: false,
        encryptionKey: key,
      });
      expect(encryptedChild.encryptionKey).toBe(key);

      await flush();
      plaintextChild.destroy({ destroyConnection: false });
      encryptedChild.destroy({ destroyConnection: false });
      plaintextProvider.destroy({ destroyConnection: false });
      provider.destroy({ destroyConnection: false });
      await flush();
      await clientConn.destroy();
      await serverConn.destroy();
      await clientConn2.destroy();
      await serverConn2.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // 11. Offline persistence (encrypted at rest)
  // -----------------------------------------------------------------------
  describe("offline persistence (encrypted at rest)", () => {
    /** Create an isolated in-memory storage (not sharing the static Map). */
    function createIsolatedStorage(encrypted: boolean = false) {
      const docs = new Map<string, any>();
      const storage = new MemoryDocumentStorage(encrypted, {
        write: async (key, doc) => {
          docs.set(key, doc);
        },
        fetch: async (key) => docs.get(key),
        delete: async (key) => {
          docs.delete(key);
        },
        pendingMap: new Map(),
      });
      return storage;
    }

    /** Helper: create a connected provider with an injected in-memory storage backend. */
    async function createPersistentProvider(options: {
      encryptionKey: CryptoKey | false;
      offlineStorage: MemoryDocumentStorage;
      document?: string;
    }) {
      const [clientTransport, serverTransport] = createMemoryTransportPair();
      const clientConn = new Connection({
        transports: [clientTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      const serverConn = new Connection({
        transports: [serverTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      await Promise.all([clientConn.connect(), serverConn.connect()]);

      const provider = new Provider({
        connection: clientConn,
        document: options.document ?? "test-doc",
        enableOfflinePersistence: true,
        offlineStorage: options.offlineStorage,
        encryptionKey: options.encryptionKey,
        rpc: {},
      });

      return { provider, clientConn, serverConn, clientTransport, serverTransport };
    }

    it("persists outgoing plaintext edits to offline storage", async () => {
      const offlineStorage = createIsolatedStorage();
      const { provider, clientConn, serverConn } = await createPersistentProvider({
        encryptionKey: false,
        offlineStorage,
      });

      // Wait for init (sync-step-1 send)
      await flush();

      // Make an edit — the transport will produce an update message
      provider.doc.getText("body").insert(0, "offline test");
      await flush();
      await flush();

      // Check that something was persisted
      const stored = await offlineStorage.getDocument("test-doc");
      expect(stored).not.toBeNull();

      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });

    it("persists incoming server updates to offline storage", async () => {
      const offlineStorage = createIsolatedStorage();
      const { provider, clientConn, serverConn } = await createPersistentProvider({
        encryptionKey: false,
        offlineStorage,
      });

      await flush();

      // Simulate server sending a sync-step-2 in content-encrypted format
      const serverDoc = new Y.Doc();
      serverDoc.getText("body").insert(0, "from server");
      const v2 = Y.encodeStateAsUpdateV2(serverDoc);
      const payload = encodeContentEncryptedPayload({
        structureUpdate: v2,
        encryptedSidecars: [],
      });
      const syncStep2 = new DocMessage(
        "test-doc",
        {
          type: "sync-step-2" as const,
          update: { version: 2, data: payload as any },
        },
        {},
        false,
      );
      await serverConn.send(syncStep2);
      await flush();
      await flush();

      const stored = await offlineStorage.getDocument("test-doc");
      expect(stored).not.toBeNull();

      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
      serverDoc.destroy();
    });

    it("replays persisted state into a fresh provider (offline-first)", async () => {
      const offlineStorage = createIsolatedStorage();

      // First provider: edit and persist.
      const {
        provider: p1,
        clientConn: c1,
        serverConn: s1,
      } = await createPersistentProvider({
        encryptionKey: false,
        offlineStorage,
      });
      await flush();

      // Simulate receiving a sync-step-2 in content-encrypted format
      const sourceDoc = new Y.Doc();
      sourceDoc.getText("body").insert(0, "persisted content");
      const v2 = Y.encodeStateAsUpdateV2(sourceDoc);
      const payload = encodeContentEncryptedPayload({
        structureUpdate: v2,
        encryptedSidecars: [],
      });
      const syncStep2 = new DocMessage(
        "test-doc",
        {
          type: "sync-step-2" as const,
          update: { version: 2, data: payload as any },
        },
        {},
        false,
      );
      await s1.send(syncStep2);
      await flush();
      await flush();

      p1.destroy({ destroyConnection: false });
      await c1.destroy();
      await s1.destroy();

      // Verify data persisted
      const stored = await offlineStorage.getDocument("test-doc");
      expect(stored).not.toBeNull();

      // Second provider: should replay persisted state.
      const {
        provider: p2,
        clientConn: c2,
        serverConn: s2,
      } = await createPersistentProvider({
        encryptionKey: false,
        offlineStorage,
      });

      await p2.loaded;
      await flush();

      expect(p2.doc.getText("body").toString()).toBe("persisted content");

      p2.destroy({ destroyConnection: false });
      await c2.destroy();
      await s2.destroy();
      sourceDoc.destroy();
    });

    it("clearOfflineData removes persisted data", async () => {
      const offlineStorage = createIsolatedStorage();
      const { provider, clientConn, serverConn } = await createPersistentProvider({
        encryptionKey: false,
        offlineStorage,
      });
      await flush();

      // Persist something in content-encrypted format
      const sourceDoc = new Y.Doc();
      sourceDoc.getText("body").insert(0, "to delete");
      const v2 = Y.encodeStateAsUpdateV2(sourceDoc);
      const payload = encodeContentEncryptedPayload({
        structureUpdate: v2,
        encryptedSidecars: [],
      });
      const syncStep2 = new DocMessage(
        "test-doc",
        {
          type: "sync-step-2" as const,
          update: { version: 2, data: payload as any },
        },
        {},
        false,
      );
      await serverConn.send(syncStep2);
      await flush();
      await flush();

      expect(await offlineStorage.getDocument("test-doc")).not.toBeNull();

      await provider.clearOfflineData();

      expect(await offlineStorage.getDocument("test-doc")).toBeNull();

      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
      sourceDoc.destroy();
    });

    it("SSR guard: offline persistence disabled when no window/indexedDB", async () => {
      // When offlineStorage is NOT injected AND window is undefined (SSR),
      // the provider should disable persistence gracefully.
      const [clientTransport, serverTransport] = createMemoryTransportPair();
      const clientConn = new Connection({
        transports: [clientTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      const serverConn = new Connection({
        transports: [serverTransport],
        connect: false,
        batchIntervalMs: 0,
      });
      await Promise.all([clientConn.connect(), serverConn.connect()]);

      // In bun test, globalThis.window is undefined, and there's no
      // indexedDB. Without an injected offlineStorage, the guard should
      // skip persistence without throwing.
      const provider = new Provider({
        connection: clientConn,
        document: "ssr-doc",
        enableOfflinePersistence: true,
        encryptionKey: false,
        rpc: {},
      });

      await flush();

      // loaded should fall back to synced (since no local persistence)
      const loadedPromise = provider.loaded;
      expect(loadedPromise).toBeInstanceOf(Promise);
      // Swallow the rejection that destroy() causes on synced/loaded
      loadedPromise.catch(() => {});

      provider.destroy({ destroyConnection: false });
      await clientConn.destroy();
      await serverConn.destroy();
    });
  });
});
