import { describe, expect, it } from "bun:test";
import { InMemoryPubSub, type Message, type ServerContext } from "teleportal";
import { MemoryDocumentStorage } from "../../storage/in-memory/document-storage";
import { Session } from "../../server/session";
import { Server } from "../../server/server";
import { DirectConnection } from "../connection";
import { Provider, type PresenceEvent } from "../provider";
import { createMemoryTransportPair } from "../transports/memory";
import { ConnectionWorkerManager } from "./connection-worker-manager";
import { WorkerConnection } from "./worker-connection";

const DOC = "test-doc";
const SHORT_GRACE_MS = 5;

function tick(ms = 1) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Poll until `condition` holds (event-driven wait, no fixed sleeps). */
async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await tick();
  }
}

function createSession() {
  const session = new Session<ServerContext>({
    documentId: DOC,
    namespacedDocumentId: DOC,
    id: "session-1",
    encrypted: false,
    storage: new MemoryDocumentStorage(),
    pubSub: new InMemoryPubSub(),
    nodeId: "test-node",
    onCleanupScheduled: () => {},
    server: new Server<ServerContext>({
      storage: async () => {
        throw new Error("not used");
      },
    }),
  });
  return session;
}

/**
 * Bridge the server side of a memory transport pair into the session as one
 * session client — the same role the websocket server plays in production.
 */
async function bridgeToSession(
  session: Session<ServerContext>,
  serverTransport: ReturnType<typeof createMemoryTransportPair>[1],
  clientId: string,
  userId: string,
) {
  const serverConn = new DirectConnection({
    transports: [serverTransport],
    connect: false,
    batchIntervalMs: 0,
  });
  const sessionClient = {
    id: clientId,
    send: (message: Message<ServerContext>) => serverConn.send(message),
    destroy() {},
  };
  serverConn.on("received-message", (message) => {
    // Production attaches the authenticated context after decode; do the same.
    (message as Message<ServerContext>).context = {
      clientId,
      userId,
      room: "room",
    } as ServerContext;
    void session.apply(message as Message<ServerContext>, sessionClient as any).catch(() => {});
  });
  await serverConn.connect();
  session.addClient(sessionClient as any);
  return { serverConn, sessionClient };
}

/** A "browser tab": a WorkerConnection port pair plus a Provider on top. */
function createTab(manager: ConnectionWorkerManager, tabId: string) {
  const channel = new MessageChannel();
  manager.addPort(channel.port1);
  const conn = new WorkerConnection(channel.port2);
  conn.init({ connect: true, url: "ws://shared" }, tabId);
  const provider = new Provider({
    connection: conn,
    document: DOC,
    enableOfflinePersistence: false,
    rpc: {},
    encryptionKey: false,
  });
  return { channel, conn, provider };
}

function trackPresence(provider: Provider<any, any>) {
  const joins: PresenceEvent[] = [];
  const leaves: PresenceEvent[] = [];
  provider.on("peer-join", (peer) => joins.push(peer));
  provider.on("peer-leave", (peer) => leaves.push(peer));
  return { joins, leaves };
}

describe("SharedWorker presence end-to-end", () => {
  it("tracks tabs joining, refreshing, and leaving through a real session", async () => {
    const session = createSession();

    // One SharedWorker with a pooled connection for all tabs of this "browser".
    const [workerClientTransport, workerServerTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [workerClientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });
    await bridgeToSession(session, workerServerTransport, "worker-client", "user-shared");

    // A remote peer on its own direct connection (a different browser).
    const [peerClientTransport, peerServerTransport] = createMemoryTransportPair();
    await bridgeToSession(session, peerServerTransport, "peer-client", "user-peer");
    const peerConn = new DirectConnection({
      transports: [peerClientTransport],
      connect: false,
      batchIntervalMs: 0,
    });
    await peerConn.connect();
    const peer = new Provider({
      connection: peerConn,
      document: DOC,
      enableOfflinePersistence: false,
      rpc: {},
      encryptionKey: false,
    });
    const peerSees = trackPresence(peer);

    // Two tabs of the same document share the worker connection; the session
    // must track both awarenessIds under the one shared client.
    const tabA = createTab(manager, "tab-a");
    const tabB = createTab(manager, "tab-b");
    const idA = tabA.provider.awareness.clientID;
    const idB = tabB.provider.awareness.clientID;

    await waitFor(() => peerSees.joins.length >= 2);
    expect(peerSees.joins.map((p) => p.awarenessId).sort()).toEqual([idA, idB].sort());
    expect(peerSees.joins.every((p) => p.clientId === "worker-client")).toBe(true);

    // Awareness still flows end-to-end: tab A's cursor state reaches the peer.
    tabA.provider.awareness.setLocalState({ user: "alice" });
    await waitFor(() => peer.awareness.getStates().has(idA));
    expect(peer.awareness.getStates().get(idA)).toEqual({ user: "alice" });

    // Tab A is refreshed: the browser fires `close` on the worker-side port
    // before any destroy message can be sent. Exactly tab A's presence is
    // retracted — tab B is untouched.
    tabA.channel.port1.dispatchEvent(new Event("close"));
    await waitFor(() => peerSees.leaves.length >= 1);
    expect(peerSees.leaves.map((p) => p.awarenessId)).toEqual([idA]);
    // The peer also clears the dead tab's awareness state.
    await waitFor(() => !peer.awareness.getStates().has(idA));

    // The refreshed page comes back as a new tab with a new awarenessId.
    const tabA2 = createTab(manager, "tab-a2");
    const idA2 = tabA2.provider.awareness.clientID;
    await waitFor(() => peerSees.joins.some((p) => p.awarenessId === idA2));
    expect(peerSees.leaves).toHaveLength(1);

    // A newcomer's roster replay contains the shared client's full set of
    // live awarenessIds — and nothing for the refreshed-away tab.
    const [lateClientTransport, lateServerTransport] = createMemoryTransportPair();
    await bridgeToSession(session, lateServerTransport, "late-client", "user-late");
    const lateConn = new DirectConnection({
      transports: [lateClientTransport],
      connect: false,
      batchIntervalMs: 0,
    });
    await lateConn.connect();
    const late = new Provider({
      connection: lateConn,
      document: DOC,
      enableOfflinePersistence: false,
      rpc: {},
      encryptionKey: false,
    });
    const lateSees = trackPresence(late);
    await waitFor(() => lateSees.joins.length >= 3);
    const rosterFromWorker = lateSees.joins
      .filter((p) => p.clientId === "worker-client")
      .map((p) => p.awarenessId)
      .sort();
    expect(rosterFromWorker).toEqual([idB, idA2].sort());
    expect(lateSees.joins.some((p) => p.awarenessId === idA)).toBe(false);

    await Promise.all([
      tabB.provider.destroy(),
      tabA2.provider.destroy(),
      peer.destroy(),
      late.destroy(),
    ]);
    await tick(SHORT_GRACE_MS * 3);
    await session[Symbol.asyncDispose]();
  });

  it("sibling tabs on one pooled connection sync docs, awareness, and presence with each other", async () => {
    const session = createSession();

    const [workerClientTransport, workerServerTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [workerClientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });
    await bridgeToSession(session, workerServerTransport, "worker-client", "user-shared");

    // Two tabs of the same browser: same URL + token → one pooled connection.
    // The server excludes the shared client from its broadcasts, so all
    // tab-to-tab traffic must be relayed inside the worker.
    const tabA = createTab(manager, "tab-a");
    const tabB = createTab(manager, "tab-b");
    const idA = tabA.provider.awareness.clientID;
    const bSees = trackPresence(tabB.provider);

    // Presence: tab B learns tab A exists (and never sees itself).
    await waitFor(() => bSees.joins.some((p) => p.awarenessId === idA));
    expect(bSees.joins.some((p) => p.awarenessId === tabB.provider.awareness.clientID)).toBe(false);

    // Awareness: tab A's cursor state reaches tab B.
    tabA.provider.awareness.setLocalState({ user: "alice" });
    await waitFor(() => tabB.provider.awareness.getStates().has(idA));
    expect(tabB.provider.awareness.getStates().get(idA)).toEqual({ user: "alice" });

    // Document content: tab A's edit reaches tab B.
    tabA.provider.doc.getText("t").insert(0, "hello");
    await waitFor(() => tabB.provider.doc.getText("t").toString() === "hello");

    await Promise.all([tabA.provider.destroy(), tabB.provider.destroy()]);
    await tick(SHORT_GRACE_MS * 3);
    await session[Symbol.asyncDispose]();
  });

  it("destroying one tab's provider retracts only that tab's presence", async () => {
    const session = createSession();

    const [workerClientTransport, workerServerTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [workerClientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });
    await bridgeToSession(session, workerServerTransport, "worker-client", "user-shared");

    const [peerClientTransport, peerServerTransport] = createMemoryTransportPair();
    await bridgeToSession(session, peerServerTransport, "peer-client", "user-peer");
    const peerConn = new DirectConnection({
      transports: [peerClientTransport],
      connect: false,
      batchIntervalMs: 0,
    });
    await peerConn.connect();
    const peer = new Provider({
      connection: peerConn,
      document: DOC,
      enableOfflinePersistence: false,
      rpc: {},
      encryptionKey: false,
    });
    const peerSees = trackPresence(peer);

    const tabA = createTab(manager, "tab-a");
    const tabB = createTab(manager, "tab-b");
    const idA = tabA.provider.awareness.clientID;
    const idB = tabB.provider.awareness.clientID;
    await waitFor(() => peerSees.joins.length >= 2);

    // Tab A switches documents: its provider is destroyed cleanly. The
    // unannounce it sends must not disturb tab B on the same connection.
    await tabA.provider.destroy();
    await waitFor(() => peerSees.leaves.length >= 1);
    expect(peerSees.leaves.map((p) => p.awarenessId)).toEqual([idA]);
    expect(peerSees.joins.map((p) => p.awarenessId)).toContain(idB);

    await Promise.all([tabB.provider.destroy(), peer.destroy()]);
    await tick(SHORT_GRACE_MS * 3);
    await session[Symbol.asyncDispose]();
  });
});
