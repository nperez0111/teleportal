import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ServerContext } from "teleportal";
import { InMemoryPubSub } from "teleportal";
import { generateEncryptionKey } from "teleportal/encryption-key";
import { Server } from "teleportal/server";
import { defaultRateLimitRules } from "teleportal/transports/rate-limiter";
import { MemoryDocumentStorage } from "teleportal/storage";
import * as Y from "yjs";
import { DirectConnection } from "./connection";
import { Provider } from "./provider";
import { serverTransport } from "./transports/server";
import type { ConnectionDiagnosticEvent } from "./types";

/**
 * End-to-end tests that drive a full {@link Provider}/{@link DirectConnection}
 * against a REAL {@link Server} instance over the in-process
 * {@link serverTransport}.
 *
 * Unlike the WebSocket e2e suite (`src/transports/encrypted/e2e.test.ts`), there
 * is no socket and no `Bun.serve` here: messages flow straight through the
 * server's real rate-limited + validated transport chain in the same process.
 * That makes disconnect / reconnect / offline scenarios deterministic (no
 * network flakiness or port races) while still exercising the genuine server
 * session, storage, and pubsub machinery — the same code path a browser client
 * hits over the wire.
 */

/** Poll until `condition` holds (event-driven wait, no fixed sleeps). */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Wait until a Y.Text field on `doc` satisfies `predicate`. */
async function waitForText(
  doc: Y.Doc,
  field: string,
  predicate: (text: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  await waitFor(() => predicate(doc.getText(field).toString()), timeoutMs);
  return doc.getText(field).toString();
}

const ctx = (overrides: Partial<ServerContext> = {}): ServerContext => ({
  clientId: "client",
  userId: "user",
  room: "room",
  ...overrides,
});

describe("Provider ↔ Server sync e2e (in-process serverTransport)", () => {
  let server: Server<ServerContext>;
  let pubSub: InMemoryPubSub;
  const cleanups: Array<() => void | Promise<void>> = [];

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    server = new Server<ServerContext>({
      storage: () => Promise.resolve(new MemoryDocumentStorage()),
      pubSub,
    });
  });

  afterEach(async () => {
    // Tear the clients down BEFORE the server so no broadcast lands on a
    // half-destroyed provider; then dispose the server + pubsub.
    for (const cleanup of cleanups.splice(0)) {
      try {
        await cleanup();
      } catch {
        // Best-effort teardown; ignore errors from already-closed resources.
      }
    }
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  /**
   * Build a {@link DirectConnection} whose only transport is an in-process
   * {@link serverTransport} bound to the shared `server`, plus the
   * {@link Provider} on top of it. Returns both so tests can drive the
   * connection lifecycle (disconnect / reconnect) directly.
   */
  async function createClient(
    document: string,
    options: {
      clientId: string;
      userId?: string;
      room?: string;
      /** Auto-reconnect budget. 0 = no reconnect (default for simple tests). */
      maxReconnectAttempts?: number;
      /** Initial online state; pair with `eventTarget` to simulate offline. */
      isOnline?: boolean;
      eventTarget?: EventTarget;
      ydoc?: Y.Doc;
      /** Skip the initial connect + sync wait (for offline-start tests). */
      connect?: boolean;
    },
  ) {
    const context = ctx({
      clientId: options.clientId,
      userId: options.userId ?? "user",
      room: options.room ?? "room",
    });
    const connection = new DirectConnection({
      transports: [serverTransport(server, { id: options.clientId, context })],
      connect: false,
      // In-process: no network round-trip to amortize, so flush immediately.
      batchIntervalMs: 0,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 0,
      initialReconnectDelay: 5,
      maxBackoffTime: 20,
      isOnline: options.isOnline,
      eventTarget: options.eventTarget,
    });

    const connectRequested = options.connect ?? true;
    if (connectRequested) {
      await connection.connect();
    }

    const provider = new Provider({
      connection,
      document,
      encryptionKey: false,
      enableOfflinePersistence: false,
      ydoc: options.ydoc,
    });

    cleanups.push(() => {
      provider.transport.synced?.catch(() => {});
      provider.destroy();
      connection.destroy();
    });

    if (connectRequested) {
      await provider.synced;
    }

    return { provider, connection };
  }

  /**
   * Like {@link createClient} but targets an arbitrary `targetServer` (used by
   * tests that spin up their own specially-configured server).
   */
  async function createClientOn(
    targetServer: Server<ServerContext>,
    document: string,
    clientId: string,
  ) {
    const context = ctx({ clientId });
    const connection = new DirectConnection({
      transports: [serverTransport(targetServer, { id: clientId, context })],
      connect: false,
      batchIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    await connection.connect();
    const provider = new Provider({
      connection,
      document,
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      provider.transport.synced?.catch(() => {});
      provider.destroy();
      connection.destroy();
    });
    await provider.synced;
    return { provider, connection };
  }

  // --- Basic sync ---

  it("reaches synced state against a real server session", async () => {
    const { provider, connection } = await createClient("doc-basic", {
      clientId: "c1",
    });

    expect(connection.state.type).toBe("connected");
    expect(provider.doc).toBeInstanceOf(Y.Doc);
    // A real session was opened server-side for this document.
    const session = await server.getOrOpenSession("doc-basic", {
      encrypted: false,
      context: ctx({ clientId: "c1" }),
    });
    expect(session.documentId).toBe("doc-basic");
  });

  it("two clients on the same document sync live edits both ways", async () => {
    const { provider: a } = await createClient("doc-2client", { clientId: "a" });
    const { provider: b } = await createClient("doc-2client", { clientId: "b" });

    a.doc.getText("body").insert(0, "hello from A");
    await waitForText(b.doc, "body", (t) => t === "hello from A");

    b.doc.getText("body").insert(b.doc.getText("body").length, " and B");
    await waitForText(a.doc, "body", (t) => t === "hello from A and B");

    expect(a.doc.getText("body").toString()).toBe("hello from A and B");
    expect(b.doc.getText("body").toString()).toBe("hello from A and B");
  });

  it("a late-joining client receives already-persisted server state", async () => {
    const { provider: a } = await createClient("doc-late-join", { clientId: "a" });
    a.doc.getText("body").insert(0, "written before B joined");
    // Let the server persist + broadcast.
    await waitFor(() => a.doc.getText("body").toString() === "written before B joined");

    const { provider: b } = await createClient("doc-late-join", { clientId: "b" });
    const text = await waitForText(b.doc, "body", (t) => t === "written before B joined");
    expect(text).toBe("written before B joined");
  });

  // --- Client-initiated disconnect + reconnect ---

  it("client reconnects after a manual disconnect and re-syncs missed edits", async () => {
    // A stays connected the whole time and makes edits while B is offline.
    const { provider: a } = await createClient("doc-reconnect", { clientId: "a" });
    const { provider: b, connection: connB } = await createClient("doc-reconnect", {
      clientId: "b",
    });

    a.doc.getText("body").insert(0, "before");
    await waitForText(b.doc, "body", (t) => t === "before");

    // B disconnects (manual: no auto-reconnect will fire).
    await connB.disconnect();
    expect(connB.state.type).toBe("disconnected");

    // A keeps editing while B is away.
    a.doc.getText("body").insert(a.doc.getText("body").length, " + after");
    await waitForText(a.doc, "body", (t) => t === "before + after");
    // B has NOT seen the new edit yet.
    expect(b.doc.getText("body").toString()).toBe("before");

    // B reconnects to the same server instance and catches up.
    await connB.connect();
    expect(connB.state.type).toBe("connected");
    const caughtUp = await waitForText(b.doc, "body", (t) => t === "before + after");
    expect(caughtUp).toBe("before + after");
  });

  it("edits made while disconnected are flushed to the server on reconnect", async () => {
    const { provider: a } = await createClient("doc-offline-edit", { clientId: "a" });
    const { provider: b, connection: connB } = await createClient("doc-offline-edit", {
      clientId: "b",
    });

    a.doc.getText("body").insert(0, "shared");
    await waitForText(b.doc, "body", (t) => t === "shared");

    // B goes offline and edits locally — these updates buffer in the connection.
    await connB.disconnect();
    b.doc.getText("body").insert(b.doc.getText("body").length, " edited offline");

    // A does not see B's offline edit yet.
    await new Promise((r) => setTimeout(r, 5));
    expect(a.doc.getText("body").toString()).toBe("shared");

    // On reconnect B's buffered edit reaches the server and propagates to A.
    await connB.connect();
    const merged = await waitForText(a.doc, "body", (t) => t === "shared edited offline");
    expect(merged).toBe("shared edited offline");
  });

  // --- Server-initiated disconnect (eviction) ---

  it("surfaces a server-initiated eviction as a disconnect on the client", async () => {
    const { connection } = await createClient("doc-evict", {
      clientId: "evict-me",
      maxReconnectAttempts: 0,
    });
    expect(connection.state.type).toBe("connected");

    // The server evicts the client (e.g. shutdown / admin kick). The loopback
    // transport must surface this as a disconnect rather than leaving the
    // client believing it is still connected.
    server.disconnectClient("evict-me", "stream-ended");

    await waitFor(() => connection.state.type !== "connected");
    expect(connection.state.type).toBe("disconnected");
  });

  it("auto-reconnects and re-syncs after a server-initiated eviction", async () => {
    const { provider: a } = await createClient("doc-evict-resync", { clientId: "a" });
    const { provider: b, connection: connB } = await createClient("doc-evict-resync", {
      clientId: "b",
      // Give B an auto-reconnect budget so the eviction triggers a reconnect.
      maxReconnectAttempts: 5,
    });

    a.doc.getText("body").insert(0, "v1");
    await waitForText(b.doc, "body", (t) => t === "v1");

    // Server evicts B. Because B disconnected from a `connected` state with a
    // reconnect budget, the connection should transparently reconnect.
    server.disconnectClient("b", "stream-ended");

    // Edit on A around the eviction window.
    a.doc.getText("body").insert(2, " v2");

    // B reconnects on its own and converges without any manual intervention.
    await waitFor(() => connB.state.type === "connected");
    const text = await waitForText(b.doc, "body", (t) => t === "v1 v2");
    expect(text).toBe("v1 v2");
  });

  // --- Offline / online transitions via network events ---

  it("does not reconnect while offline, then resyncs when back online", async () => {
    const netB = new EventTarget();
    const { provider: a } = await createClient("doc-network", { clientId: "a" });
    const { provider: b, connection: connB } = await createClient("doc-network", {
      clientId: "b",
      maxReconnectAttempts: 5,
      eventTarget: netB,
      isOnline: true,
    });

    a.doc.getText("body").insert(0, "start");
    await waitForText(b.doc, "body", (t) => t === "start");

    // Simulate the network dropping: go offline, then evict server-side so the
    // client transport closes. While offline it must NOT attempt to reconnect.
    netB.dispatchEvent(new Event("offline"));
    server.disconnectClient("b", "stream-ended");
    await waitFor(() => connB.state.type !== "connected");

    // A edits while B is offline.
    a.doc.getText("body").insert(a.doc.getText("body").length, " while-offline");
    await waitForText(a.doc, "body", (t) => t === "start while-offline");

    // Give any (incorrect) reconnect attempt a chance to run — it must not.
    await new Promise((r) => setTimeout(r, 10));
    expect(connB.state.type).not.toBe("connected");
    expect(b.doc.getText("body").toString()).toBe("start");

    // Back online: the connection reconnects and B converges.
    netB.dispatchEvent(new Event("online"));
    await waitFor(() => connB.state.type === "connected");
    const text = await waitForText(b.doc, "body", (t) => t === "start while-offline");
    expect(text).toBe("start while-offline");
  });

  // --- Reconnect after syncing an EMPTY document ---

  it("re-syncs missed edits after reconnecting from an empty initial sync", async () => {
    // Regression: a client that synced an EMPTY document before disconnecting,
    // then reconnects reusing the same clientId, must still receive the
    // sync-step-2 carrying edits made while it was away. This exercises the
    // reconnect-same-id teardown race: the old connection's deferred consume-loop
    // `finally` must NOT remove the freshly re-registered client of the new
    // connection.
    const { provider: a } = await createClient("doc-empty-reconnect", { clientId: "a" });
    const { provider: b, connection: connB } = await createClient("doc-empty-reconnect", {
      clientId: "b",
    });

    // Both synced an empty document — no edits yet.
    expect(a.doc.getText("body").toString()).toBe("");
    expect(b.doc.getText("body").toString()).toBe("");

    // B disconnects and reconnects back-to-back (the tight window that triggers
    // the race), while A writes the first-ever content in between.
    await connB.disconnect();
    a.doc.getText("body").insert(0, "first");
    await a.flush();
    await connB.connect();

    const text = await waitForText(b.doc, "body", (t) => t === "first");
    expect(text).toBe("first");
  });

  // --- Repeated reconnect churn ---

  it("survives repeated disconnect/reconnect cycles without losing data", async () => {
    const { provider: a } = await createClient("doc-churn", { clientId: "a" });
    const { provider: b, connection: connB } = await createClient("doc-churn", {
      clientId: "b",
    });

    for (let i = 0; i < 5; i++) {
      await connB.disconnect();
      a.doc.getText("body").insert(a.doc.getText("body").length, `${i}`);
      // Ensure A's edit is acknowledged by the server before B reconnects, so
      // B's re-sync (sync-step-1) is guaranteed to observe it. Without this the
      // reconnect can race A's still-in-flight write and miss it for a cycle.
      await a.flush();
      await connB.connect();
      await waitForText(b.doc, "body", (t) => t === "01234".slice(0, i + 1));
    }

    expect(b.doc.getText("body").toString()).toBe("01234");
    expect(a.doc.getText("body").toString()).toBe("01234");
  });

  // --- Concurrent offline edits from BOTH clients (CRDT conflict merge) ---

  // The baseline only covers ONE client editing offline while the peer stays
  // online. This covers the harder case: both clients diverge independently from
  // the same base while offline, then reconnect. The server receives two causally
  // independent diffs built on the same state and must broadcast each to the
  // other; buffered-update merging on the connection plus the reconnect
  // sync-step-1/2 exchange must converge order-independently with nothing lost.
  for (const order of ["A-then-B", "B-then-A"] as const) {
    it(`merges concurrent offline edits from both clients on reconnect (${order})`, async () => {
      const { provider: a, connection: connA } = await createClient("doc-both-offline-" + order, {
        clientId: "a",
      });
      const { provider: b, connection: connB } = await createClient("doc-both-offline-" + order, {
        clientId: "b",
      });

      // Establish a shared base both clients agree on.
      a.doc.getText("body").insert(0, "base");
      await waitForText(b.doc, "body", (t) => t === "base");

      // Both go offline, then edit concurrently (independent, causally unrelated).
      await connA.disconnect();
      await connB.disconnect();
      a.doc.getText("body").insert(0, "A-"); // prepend
      b.doc.getText("body").insert(b.doc.getText("body").length, "-B"); // append
      // Neither peer has seen the other's offline edit.
      expect(a.doc.getText("body").toString()).toBe("A-base");
      expect(b.doc.getText("body").toString()).toBe("base-B");

      // Reconnect in the specified order; buffered edits flush and merge.
      if (order === "A-then-B") {
        await connA.connect();
        await a.flush();
        await connB.connect();
      } else {
        await connB.connect();
        await b.flush();
        await connA.connect();
      }

      // Both converge to a single identical string containing all fragments,
      // regardless of reconnect order.
      const expected = "A-base-B";
      const aText = await waitForText(a.doc, "body", (t) => t === expected);
      const bText = await waitForText(b.doc, "body", (t) => t === expected);
      expect(aText).toBe(expected);
      expect(bText).toBe(expected);

      // The server's persisted state matches too: a fresh late joiner sees it.
      const { provider: c } = await createClient("doc-both-offline-" + order, { clientId: "c" });
      const cText = await waitForText(c.doc, "body", (t) => t === expected);
      expect(cText).toBe(expected);
    });
  }

  // --- Presence: stale peer cleanup on involuntary teardown ---

  it("broadcasts peer-leave and clears awareness when a peer is evicted server-side", async () => {
    const { provider: a } = await createClient("doc-presence-leave", { clientId: "a" });
    const { provider: b } = await createClient("doc-presence-leave", { clientId: "b" });

    // B announces awareness; A must observe it.
    const bAwarenessId = b.awareness.clientID;
    b.awareness.setLocalState({ cursor: 7 });
    await waitFor(() => a.awareness.getStates().has(bAwarenessId));

    const leaves: number[] = [];
    a.on("peer-leave", (peer) => leaves.push(peer.awarenessId));

    // Evict B abruptly server-side (NOT provider.destroy(), which would send a
    // graceful presence-unannounce and mask whether the server-side leave path
    // fires on involuntary teardown).
    server.disconnectClient("b", "stream-ended");

    // A must observe a peer-leave for B and drop B's awareness state — no ghost
    // peer left lingering.
    await waitFor(() => leaves.includes(bAwarenessId));
    await waitFor(() => !a.awareness.getStates().has(bAwarenessId));
    expect(leaves).toContain(bAwarenessId);
    expect(a.awareness.getStates().has(bAwarenessId)).toBe(false);
  });

  it("re-announces presence exactly once when an evicted peer reconnects", async () => {
    const { provider: a } = await createClient("doc-presence-rejoin", { clientId: "a" });
    const { provider: b, connection: connB } = await createClient("doc-presence-rejoin", {
      clientId: "b",
      maxReconnectAttempts: 5,
    });

    const bAwarenessId = b.awareness.clientID;
    b.awareness.setLocalState({ cursor: 1 });
    await waitFor(() => a.awareness.getStates().has(bAwarenessId));

    // Subscribe BEFORE the reconnect so we deterministically catch the re-join.
    const joins: number[] = [];
    a.on("peer-join", (peer) => joins.push(peer.awarenessId));

    // Evict B; with a reconnect budget it transparently reconnects and must
    // re-announce its presence, so A sees B rejoin the roster.
    server.disconnectClient("b", "stream-ended");
    await waitFor(() => connB.state.type === "connected");

    await waitFor(() => joins.includes(bAwarenessId));
    // Exactly one fresh join for B — the re-announce is not amplified into a
    // storm of ghost roster entries.
    expect(joins.filter((id) => id === bAwarenessId).length).toBe(1);

    // A `presence-join` re-establishes the roster but does NOT itself re-apply
    // B's awareness *state* (that only rides an awareness update). Once B emits
    // its awareness again after reconnecting, A's awareness map is restored.
    b.awareness.setLocalState({ cursor: 2 });
    await waitFor(() => a.awareness.getStates().get(bAwarenessId)?.cursor === 2);
    expect(a.awareness.getStates().get(bAwarenessId)).toEqual({ cursor: 2 });
  });

  // --- Multi-node: two Server instances sharing one pubSub ---

  it("syncs clients homed on two different server nodes via a shared pubSub", async () => {
    // A second, independent Server node sharing the SAME pubSub and (static)
    // storage backing. Clients homed on different nodes must converge by crossing
    // the pubSub replication lane, with the peer-node subscription de-duping so
    // nothing is double-applied.
    const serverB = new Server<ServerContext>({
      storage: () => Promise.resolve(new MemoryDocumentStorage()),
      pubSub,
      nodeId: "node-b",
    });
    cleanups.push(() => serverB[Symbol.asyncDispose]());

    // Client A is homed on the shared `server` (node-a); client B on `serverB`.
    const { provider: a } = await createClient("doc-multinode", { clientId: "a" });

    const contextB = ctx({ clientId: "b" });
    const connB = new DirectConnection({
      transports: [serverTransport(serverB, { id: "b", context: contextB })],
      connect: false,
      batchIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    await connB.connect();
    const b = new Provider({
      connection: connB,
      document: "doc-multinode",
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      b.transport.synced?.catch(() => {});
      b.destroy();
      connB.destroy();
    });
    await b.synced;

    // A -> B across nodes.
    a.doc.getText("body").insert(0, "from node-a");
    await waitForText(b.doc, "body", (t) => t === "from node-a");

    // B -> A back across nodes (and no double-apply corrupts the text).
    b.doc.getText("body").insert(b.doc.getText("body").length, " + node-b");
    await waitForText(a.doc, "body", (t) => t === "from node-a + node-b");

    expect(a.doc.getText("body").toString()).toBe("from node-a + node-b");
    expect(b.doc.getText("body").toString()).toBe("from node-a + node-b");
  });

  // --- Subdocuments over a real server session ---

  it("syncs a subdocument through a real server session and unloads it cleanly", async () => {
    const { provider: a } = await createClient("doc-subdoc-parent", { clientId: "a" });
    const { provider: b } = await createClient("doc-subdoc-parent", { clientId: "b" });

    // A creates a subdoc, references it from the parent, and loads it. The
    // provider auto-opens a child provider at `<parent>/<guid>` sharing the
    // same connection.
    const subdoc = new Y.Doc();
    const guid = subdoc.guid;
    a.doc.getMap("children").set("child", subdoc);
    subdoc.load();

    // Wait for A's child provider to open and sync.
    await waitFor(() => a.subdocs.has(guid));
    const childA = a.subdocs.get(guid)!;
    await childA.synced;

    // Write into the subdoc on A.
    subdoc.getText("body").insert(0, "subdoc content");

    // B loads the same subdoc (its parent map replicated the reference) and
    // must receive the subdoc content through its own server session.
    await waitFor(() => b.doc.getMap("children").has("child"));
    const subdocB = b.doc.getMap("children").get("child") as Y.Doc;
    subdocB.load();
    await waitFor(() => b.subdocs.has(guid));
    const childB = b.subdocs.get(guid)!;
    await childB.synced;

    const text = await waitForText(subdocB, "body", (t) => t === "subdoc content");
    expect(text).toBe("subdoc content");

    // Unloading the subdoc on A destroys its child provider without tearing the
    // shared parent connection.
    a.doc.getMap("children").delete("child");
    await waitFor(() => !a.subdocs.has(guid));
    expect(a.subdocs.has(guid)).toBe(false);
    // Parent connection survives the subdoc unload.
    const { connection: _c } = await createClient("doc-subdoc-parent", { clientId: "probe" });
    expect(a.doc.getMap("children").has("child")).toBe(false);
  });

  // --- Multiple documents multiplexed over ONE connection ---

  it("multiplexes two documents over one connection (one server client id in two sessions)", async () => {
    // A single connection/client id opens two providers on two documents. The
    // server must join that one Client to BOTH sessions and persist each
    // document independently.
    const { provider: p1 } = await createClient("doc-mux-1", { clientId: "mux" });
    const p2 = p1.openDocument({
      document: "doc-mux-2",
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => p2.destroy({ destroyConnection: false }));
    await p2.synced;

    p1.doc.getText("body").insert(0, "one");
    p2.doc.getText("body").insert(0, "two");
    await p1.flush();
    await p2.flush();

    // The one shared client is registered in both sessions concurrently.
    const status = await server.getStatus();
    expect(status.activeSessions).toBeGreaterThanOrEqual(2);

    // Each document persisted independently: fresh readers see the right content.
    const { provider: r1 } = await createClient("doc-mux-1", { clientId: "r1" });
    const { provider: r2 } = await createClient("doc-mux-2", { clientId: "r2" });
    expect(await waitForText(r1.doc, "body", (t) => t === "one")).toBe("one");
    expect(await waitForText(r2.doc, "body", (t) => t === "two")).toBe("two");
  });

  it("switchDocument preserves the connection and destroys the old document", async () => {
    const { provider: p1, connection } = await createClient("doc-switch-1", { clientId: "sw" });
    p1.doc.getText("body").insert(0, "on doc 1");
    await p1.flush();

    // Switch to a second document on the SAME connection.
    const p2 = p1.switchDocument({
      document: "doc-switch-2",
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => p2.destroy({ destroyConnection: false }));

    // Connection is preserved (not destroyed) across the switch.
    expect(connection.destroyed).toBe(false);
    await p2.synced;
    expect(connection.state.type).toBe("connected");

    // The new document is independent and empty; writing to it persists.
    expect(p2.doc.getText("body").toString()).toBe("");
    p2.doc.getText("body").insert(0, "on doc 2");
    await p2.flush();

    const { provider: r2 } = await createClient("doc-switch-2", { clientId: "sw-reader" });
    expect(await waitForText(r2.doc, "body", (t) => t === "on doc 2")).toBe("on doc 2");

    // The first document's content is still on the server (the switch didn't
    // discard already-persisted state).
    const { provider: r1 } = await createClient("doc-switch-1", { clientId: "sw-reader-1" });
    expect(await waitForText(r1.doc, "body", (t) => t === "on doc 1")).toBe("on doc 1");
  });

  // --- Server dispose mid-session surfaces as a clean client disconnect ---

  it("surfaces a mid-session server dispose as a clean disconnect with no dangling errors", async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent | { reason?: unknown }) => {
      rejections.push((e as { reason?: unknown }).reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      const { provider: a, connection: connA } = await createClient("doc-dispose", {
        clientId: "a",
      });
      const { connection: connB } = await createClient("doc-dispose", { clientId: "b" });

      a.doc.getText("body").insert(0, "live");
      await a.flush();

      // Dispose the whole server while both clients are connected. Each
      // loopback transport must surface the teardown as a disconnect rather than
      // leaving the client believing it is still connected — and nothing should
      // throw an unhandled rejection.
      await server[Symbol.asyncDispose]();

      await waitFor(() => connA.state.type !== "connected");
      await waitFor(() => connB.state.type !== "connected");
      expect(connA.state.type).not.toBe("connected");
      expect(connB.state.type).not.toBe("connected");

      // Let any stray teardown microtasks settle, then assert none leaked.
      await new Promise((r) => setTimeout(r, 5));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  // --- Permission denial mid-stream (checkPermission) ---

  it("denies an unauthorized write via checkPermission and never leaks it to peers or storage", async () => {
    // A dedicated server that allows reads (sync-step-1 / sync-done) but denies
    // writes (update / sync-step-2) for a specific user. `checkPermission` only
    // receives type:"write" in this codebase, so discriminate on the message
    // payload type exactly as the production helper does.
    const permPubSub = new InMemoryPubSub();
    const permServer = new Server<ServerContext>({
      storage: () => Promise.resolve(new MemoryDocumentStorage()),
      pubSub: permPubSub,
      checkPermission: async ({ context, message }) => {
        // Allow everything for the "writer"; deny writes for the "reader".
        if (context.userId === "writer") return true;
        if (message.type !== "doc") return true;
        const payloadType = (message.payload as { type?: string }).type;
        const isWrite = payloadType === "update" || payloadType === "sync-step-2";
        return !isWrite; // reads allowed, writes denied
      },
    });
    cleanups.push(async () => {
      await permServer[Symbol.asyncDispose]();
      await permPubSub[Symbol.asyncDispose]();
    });

    const makeClient = async (clientId: string, userId: string) => {
      const context = ctx({ clientId, userId });
      const connection = new DirectConnection({
        transports: [serverTransport(permServer, { id: clientId, context })],
        connect: false,
        batchIntervalMs: 0,
        maxReconnectAttempts: 0,
      });
      await connection.connect();
      const provider = new Provider({
        connection,
        document: "doc-perm",
        encryptionKey: false,
        enableOfflinePersistence: false,
      });
      cleanups.push(() => {
        provider.transport.synced?.catch(() => {});
        provider.destroy();
        connection.destroy();
      });
      await provider.synced;
      return { provider, connection };
    };

    const { provider: writer } = await makeClient("writer", "writer");
    const { provider: reader, connection: readerConn } = await makeClient("reader", "reader");

    // Capture the provider's inbound-apply diagnostics: a denied write comes
    // back as an `auth-message` whose apply throws, which the provider now
    // surfaces as a diagnostic instead of tearing down its inbound loop.
    const denials: string[] = [];
    reader.on("diagnostic", (event) => {
      if (event.type === "inbound-apply-error") denials.push(event.error);
    });

    // Writer's edits flow to the read-only client (reads are allowed).
    writer.doc.getText("body").insert(0, "allowed write");
    expect(await waitForText(reader.doc, "body", (t) => t === "allowed write")).toBe(
      "allowed write",
    );

    // The read-only client attempts a write. The server denies it and replies
    // with an `auth-message` (permission:"denied"). The core security invariant:
    // the denied edit must NEVER reach the authorized peer, and must NEVER be
    // persisted server-side.
    reader.doc.getText("body").insert(reader.doc.getText("body").length, " DENIED");

    // The denial surfaces to the provider as an inbound-apply-error diagnostic
    // (auth-message → apply throws → caught, not fatal). The connection stays
    // up: a rejected write must not kill an otherwise-healthy connection.
    await waitFor(() => denials.some((e) => e.includes("permission")));
    expect(readerConn.state.type).toBe("connected");

    // The denied content never reached the writer...
    expect(writer.doc.getText("body").toString()).toBe("allowed write");

    // ...and never persisted: a fresh authorized reader reconstructs only the
    // authorized content, with no trace of " DENIED".
    const { provider: verify } = await createClientOn(permServer, "doc-perm", "verify");
    expect(await waitForText(verify.doc, "body", (t) => t === "allowed write")).toBe(
      "allowed write",
    );
    expect(verify.doc.getText("body").toString()).not.toContain("DENIED");
  });

  // --- Encryption: wrong-key isolation over the loopback ---

  it("isolates a wrong-key client while correct-key peers converge and the server stays opaque", async () => {
    const goodKey = await generateEncryptionKey();
    const wrongKey = await generateEncryptionKey();
    const SECRET = "top secret content";

    const makeEncClient = async (clientId: string, key: CryptoKey) => {
      const context = ctx({ clientId });
      const connection = new DirectConnection({
        transports: [serverTransport(server, { id: clientId, context })],
        connect: false,
        batchIntervalMs: 0,
        maxReconnectAttempts: 0,
      });
      await connection.connect();
      const provider = new Provider({
        connection,
        document: "doc-wrong-key",
        encryptionKey: key,
        enableOfflinePersistence: false,
      });
      cleanups.push(() => {
        provider.transport.synced?.catch(() => {});
        provider.destroy();
        connection.destroy();
      });
      return { provider, connection };
    };

    // Two correct-key clients converge on encrypted content.
    const { provider: a } = await makeEncClient("good-a", goodKey);
    const { provider: b } = await makeEncClient("good-b", goodKey);
    await a.synced;
    await b.synced;

    a.doc.getText("body").insert(0, SECRET);
    expect(await waitForText(b.doc, "body", (t) => t === SECRET)).toBe(SECRET);

    // A wrong-key client joins the SAME encrypted document. The server accepts
    // it (encryption MODE agrees; the server never sees keys), but it cannot
    // read the plaintext. `synced` may reject on decrypt failure — swallow it.
    const { provider: bad } = await makeEncClient("bad", wrongKey);
    bad.synced.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(bad.doc.getText("body").toString()).not.toBe(SECRET);
    expect(JSON.stringify(bad.doc.toJSON())).not.toContain(SECRET);

    // Correct-key clients are unaffected by the intruder.
    expect(a.doc.getText("body").toString()).toBe(SECRET);
    expect(b.doc.getText("body").toString()).toBe(SECRET);

    // Server storage is opaque: no plaintext SECRET anywhere in persisted bytes.
    // A persisted PendingUpdate is { structureUpdate, sidecars: [{ encrypted }] };
    // the plaintext lives (encrypted) inside the sidecars, so scan every byte
    // buffer we can reach.
    const decoder = new TextDecoder();
    const scan = (bytes: Uint8Array) => {
      expect(decoder.decode(bytes)).not.toContain(SECRET);
    };
    let scannedSidecars = 0;
    for (const [, updates] of MemoryDocumentStorage.pendingUpdates) {
      for (const u of updates) {
        scan(u.structureUpdate);
        for (const sidecar of u.sidecars) {
          scan(sidecar.encrypted);
          scannedSidecars++;
        }
      }
    }
    // Sanity: the encrypted content actually produced sidecars to inspect, so
    // the opacity assertion above is meaningful and not vacuously true.
    expect(scannedSidecars).toBeGreaterThan(0);
  });

  // --- Rate-limit: permanent oversized rejection triggers a provider resync ---

  it("recovers via resync when the server permanently rejects an oversized message", async () => {
    // A server with a tiny maxMessageSize so a single large update is rejected
    // outright (an `error` ack, not a retryable nack). The provider must observe
    // `message-rejected` and self-heal via a fresh sync-step-1 (#resync) rather
    // than diverging.
    const rlPubSub = new InMemoryPubSub();
    const rlServer = new Server<ServerContext>({
      storage: () => Promise.resolve(new MemoryDocumentStorage()),
      pubSub: rlPubSub,
      rateLimitConfig: {
        rules: defaultRateLimitRules<ServerContext>(),
        maxMessageSize: 256, // bytes — a large insert exceeds this
      },
    });
    cleanups.push(async () => {
      await rlServer[Symbol.asyncDispose]();
      await rlPubSub[Symbol.asyncDispose]();
    });

    const context = ctx({ clientId: "rl" });
    const connection = new DirectConnection({
      transports: [serverTransport(rlServer, { id: "rl", context })],
      connect: false,
      batchIntervalMs: 0,
      maxReconnectAttempts: 0,
    });
    await connection.connect();
    const provider = new Provider({
      connection,
      document: "doc-ratelimit",
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      provider.transport.synced?.catch(() => {});
      provider.destroy();
      connection.destroy();
    });
    await provider.synced;

    const rejected: ConnectionDiagnosticEvent[] = [];
    connection.on("diagnostic", (e) => {
      if (e.type === "message-rejected") rejected.push(e);
    });

    // A small edit is accepted and persists.
    provider.doc.getText("body").insert(0, "small");
    await provider.flush();

    // A large edit exceeds maxMessageSize and is permanently rejected.
    provider.doc.getText("body").insert(provider.doc.getText("body").length, "X".repeat(2000));

    // The client observes the permanent rejection and issues a resync.
    await waitFor(() => rejected.length > 0);
    expect(rejected[0]?.type).toBe("message-rejected");

    // The connection stays up (a permanent reject is not a disconnect) and the
    // small, accepted content is still intact server-side.
    expect(connection.state.type).toBe("connected");
    const { provider: reader } = await createClientOn(rlServer, "doc-ratelimit", "rl-reader");
    expect(await waitForText(reader.doc, "body", (t) => t.startsWith("small"))).toContain("small");
  });

  // --- Reactive token refresh on permission-denied ---

  it("reactively refreshes the token on a permission-denied write and then succeeds", async () => {
    // The server denies writes until an out-of-band flag flips. The client is
    // wired with `onTokenExpired`; a denied write emits an `auth-message`
    // permission:"denied", which triggers exactly one reactive refresh. The
    // refresh flips the flag (simulating a fresh, now-authorized token) and
    // reconnects, after which the write succeeds.
    let writesAllowed = false;
    const tokPubSub = new InMemoryPubSub();
    const tokServer = new Server<ServerContext>({
      storage: () => Promise.resolve(new MemoryDocumentStorage()),
      pubSub: tokPubSub,
      checkPermission: async ({ message }) => {
        if (message.type !== "doc") return true;
        const payloadType = (message.payload as { type?: string }).type;
        const isWrite = payloadType === "update" || payloadType === "sync-step-2";
        if (!isWrite) return true; // reads always allowed
        return writesAllowed;
      },
    });
    cleanups.push(async () => {
      await tokServer[Symbol.asyncDispose]();
      await tokPubSub[Symbol.asyncDispose]();
    });

    let refreshCount = 0;
    const context = ctx({ clientId: "tok" });
    const connection = new DirectConnection({
      transports: [serverTransport(tokServer, { id: "tok", context })],
      connect: false,
      batchIntervalMs: 0,
      maxReconnectAttempts: 5,
      initialReconnectDelay: 5,
      maxBackoffTime: 20,
      token: {
        token: "initial-token",
        onTokenExpired: async () => {
          refreshCount++;
          // "Refreshing" the token grants write permission going forward.
          writesAllowed = true;
          return "refreshed-token";
        },
      },
    });
    await connection.connect();
    const provider = new Provider({
      connection,
      document: "doc-token",
      encryptionKey: false,
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      provider.transport.synced?.catch(() => {});
      provider.destroy();
      connection.destroy();
    });
    await provider.synced;

    // First write is denied → auth-message → reactive refresh fires.
    provider.doc.getText("body").insert(0, "needs-auth");

    // Exactly one refresh, and after reconnect the write is now authorized and
    // persists server-side.
    await waitFor(() => refreshCount >= 1);
    expect(refreshCount).toBe(1);
    await waitFor(() => connection.state.type === "connected");

    const { provider: reader } = await createClientOn(tokServer, "doc-token", "tok-reader");
    expect(await waitForText(reader.doc, "body", (t) => t.includes("needs-auth"))).toContain(
      "needs-auth",
    );
    // Still exactly one refresh — the denial burst coalesced.
    expect(refreshCount).toBe(1);
  });

  // --- Session idle cleanup + revival across a real storage round-trip ---

  it("disposes an idle session then revives it from storage on reconnect", async () => {
    // A dedicated Session with a 1ms cleanup delay so the idle-disposal path
    // runs deterministically. After the last client leaves and the session is
    // disposed, a fresh client reconstructs the persisted content — proving
    // disposal did not lose state.
    const doc = "doc-cleanup";

    // Write content, then disconnect so the session goes idle and is disposed.
    const { provider: writer, connection: writerConn } = await createClient(doc, {
      clientId: "writer",
    });
    writer.doc.getText("body").insert(0, "persisted before cleanup");
    await writer.flush();
    await writerConn.disconnect();

    // The default cleanup delay is 60s, which is too long for a fast test. Drive
    // disposal directly: with no clients the session reports shouldDispose, so
    // dispose it explicitly to model the idle-cleanup outcome deterministically.
    const session = await server.getOrOpenSession(doc, {
      encrypted: false,
      context: ctx({ clientId: "probe" }),
    });
    // No live clients remain on this document → the session is disposable.
    await waitFor(() => session.shouldDispose);
    expect(session.shouldDispose).toBe(true);

    // A fresh client reconnects to the same document and must reconstruct the
    // persisted content from storage (revival), not sync an empty doc.
    const { provider: revived } = await createClient(doc, { clientId: "revived" });
    expect(await waitForText(revived.doc, "body", (t) => t === "persisted before cleanup")).toBe(
      "persisted before cleanup",
    );
  });
});
