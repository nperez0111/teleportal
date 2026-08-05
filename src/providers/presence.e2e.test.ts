import { describe, expect, it } from "bun:test";
import type { Message, ServerContext, Transport } from "teleportal";
import { createChannel } from "../lib/iter";
import { getPresenceRpcHandlers, runPresenceMaintenance } from "../protocols/presence/server";
import { Server } from "../server/server";
import { MemoryDocumentStorage } from "../storage/in-memory/document-storage";
import { DirectConnection } from "./connection";
import { Provider, type PresenceEvent } from "./provider";
import type { ConnectionTransport, TransportConnectContext } from "./transports/types";

const DOC = "presence-doc";

function tick(ms = 1) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Poll until `condition` holds (event-driven wait, no fixed sleeps). */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await tick();
  }
}

/**
 * A reconnect-capable client transport bridged straight into
 * `server.createClient` — the role the websocket server plays in production,
 * including authenticated-context attachment and the ping→`markClientAlive`
 * liveness wiring. Every `connect()` creates a fresh server-side client (like
 * a real socket would), so reconnect flows exercise the real server paths.
 */
function serverBackedTransport(
  server: Server<ServerContext>,
  opts: { clientId: string; userId: string },
): ConnectionTransport & {
  /** Server-side client ids, one per connect() generation. */
  serverIds: string[];
  /** While false, sendHeartbeat is a no-op — simulates a wedged client. */
  heartbeatsEnabled: boolean;
  /** Drop the link like a network cut: both sides see a close. */
  dropConnection(): void;
} {
  let ctx: TransportConnectContext | null = null;
  let generation = 0;
  let closeServerSide: (() => void) | null = null;
  let deliverToServer: ((msg: Message<ServerContext>) => void) | null = null;

  const handle = {
    name: "memory-server",
    timeout: 1000,
    serverIds: [] as string[],
    heartbeatsEnabled: true,

    async connect(connectCtx: TransportConnectContext) {
      const gen = ++generation;
      ctx = connectCtx;
      const serverId = `${opts.clientId}#${gen}`;
      handle.serverIds.push(serverId);

      const ch = createChannel<Message<ServerContext>>();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        ch.close();
        if (gen === generation) {
          connectCtx.onClose();
        }
      };
      closeServerSide = close;
      deliverToServer = (msg) => {
        if (closed) return;
        Object.assign(msg.context, { clientId: serverId, userId: opts.userId, room: "room" });
        ch.send(msg);
      };

      const serverTransport: Transport<ServerContext> = {
        source: ch as AsyncIterable<Message<ServerContext>[]>,
        write: async (msg) => {
          if (closed || gen !== generation) return;
          queueMicrotask(() => {
            if (!closed && gen === generation) {
              connectCtx.onMessage(msg as never);
            }
          });
        },
        close,
      };
      server.createClient({ transport: serverTransport, id: serverId });
    },

    async send(message: Message) {
      if (!deliverToServer) {
        throw new Error("not connected");
      }
      const deliver = deliverToServer;
      queueMicrotask(() => deliver(message as Message<ServerContext>));
    },

    async close() {
      closeServerSide?.();
    },

    sendHeartbeat() {
      // Mirrors fromBinaryTransport's ping handling: the ping is answered at
      // the transport layer and reported to the server's liveness tracking.
      if (handle.heartbeatsEnabled) {
        const serverId = handle.serverIds.at(-1);
        if (serverId) {
          server.markClientAlive(serverId);
        }
        ctx?.onPing();
      }
    },

    dropConnection() {
      closeServerSide?.();
    },
  };

  return handle;
}

async function connectProvider(
  server: Server<ServerContext>,
  {
    clientId,
    userId,
    offlineTimeoutMs,
    presenceJoinGraceMs,
    heartbeatInterval = 0,
    maxReconnectAttempts,
  }: {
    clientId: string;
    userId: string;
    offlineTimeoutMs?: number;
    presenceJoinGraceMs?: number;
    heartbeatInterval?: number;
    maxReconnectAttempts?: number;
  },
) {
  const transport = serverBackedTransport(server, { clientId, userId });
  const connection = new DirectConnection({
    transports: [transport],
    connect: false,
    batchIntervalMs: 5,
    initialReconnectDelay: 1,
    heartbeatInterval,
    maxReconnectAttempts,
  });
  await connection.connect();
  const provider = new Provider({
    connection,
    document: DOC,
    encryptionKey: false,
    enableOfflinePersistence: false,
    offlineTimeoutMs,
    presenceJoinGraceMs,
  });
  await provider.synced;
  return { provider, connection, transport };
}

function makeServer(livenessConfig?: { clientTtlMs?: number }) {
  // The registry is built explicitly (instead of the default-on `presence`
  // option) so tests can drive maintenance ticks via runPresenceMaintenance.
  const registry = getPresenceRpcHandlers<ServerContext>({
    getPresenceData: (context) => ({ name: `name:${context.userId}` }),
  });
  const server = new Server<ServerContext>({
    storage: new MemoryDocumentStorage(),
    presence: false,
    rpcHandlers: registry,
    livenessConfig,
  });
  return Object.assign(server, { presenceRegistry: registry });
}

describe("presence end-to-end (Provider ↔ Server)", () => {
  it("synchronizes roster and awareness state between two clients", async () => {
    const server = makeServer();
    const a = await connectProvider(server, { clientId: "A", userId: "user-a" });
    const b = await connectProvider(server, { clientId: "B", userId: "user-b" });

    // Both learn about each other: A via B's join broadcast, B via the
    // roster replayed on announce.
    await waitFor(() => a.provider.peers.size === 1 && b.provider.peers.size === 1);
    expect(a.provider.peers.get(b.provider.awareness.clientID)?.userId).toBe("user-b");
    expect(a.provider.peers.get(b.provider.awareness.clientID)?.data).toEqual({
      name: "name:user-b",
    });
    expect(b.provider.peers.get(a.provider.awareness.clientID)?.userId).toBe("user-a");

    // Awareness state flows both ways.
    a.provider.awareness.setLocalState({ user: { name: "Alice" } });
    b.provider.awareness.setLocalState({ user: { name: "Bob" } });
    await waitFor(
      () =>
        a.provider.awareness.getStates().get(b.provider.awareness.clientID)?.user?.name === "Bob" &&
        b.provider.awareness.getStates().get(a.provider.awareness.clientID)?.user?.name === "Alice",
    );

    a.provider.destroy();
    b.provider.destroy();
    await server[Symbol.asyncDispose]();
  });

  it("clears a peer's presence and awareness when it disconnects", async () => {
    const server = makeServer();
    const a = await connectProvider(server, { clientId: "A", userId: "user-a" });
    const b = await connectProvider(server, { clientId: "B", userId: "user-b" });

    b.provider.awareness.setLocalState({ user: { name: "Bob" } });
    await waitFor(
      () =>
        a.provider.peers.size === 1 &&
        a.provider.awareness.getStates().has(b.provider.awareness.clientID),
    );

    const leaves: PresenceEvent[] = [];
    a.provider.on("peer-leave", (peer) => leaves.push(peer));

    b.provider.destroy();
    await waitFor(() => a.provider.peers.size === 0);

    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.awarenessId).toBe(b.provider.awareness.clientID);
    // The departed peer's awareness state is gone — no ghost cursor.
    expect(a.provider.awareness.getStates().has(b.provider.awareness.clientID)).toBe(false);

    a.provider.destroy();
    await server[Symbol.asyncDispose]();
  });

  it("rebuilds roster and awareness in both directions after a reconnect", async () => {
    const server = makeServer();
    // offlineTimeoutMs 0: A clears everything the moment it drops, so this
    // test proves the roster AND awareness states rebuild from scratch.
    const a = await connectProvider(server, {
      clientId: "A",
      userId: "user-a",
      offlineTimeoutMs: 0,
    });
    const b = await connectProvider(server, { clientId: "B", userId: "user-b" });

    a.provider.awareness.setLocalState({ user: { name: "Alice" } });
    b.provider.awareness.setLocalState({ user: { name: "Bob" } });
    await waitFor(
      () =>
        a.provider.awareness.getStates().get(b.provider.awareness.clientID)?.user?.name === "Bob" &&
        b.provider.awareness.getStates().get(a.provider.awareness.clientID)?.user?.name === "Alice",
    );

    // Capture the leave moments via events — the auto-reconnect (1ms delay)
    // races any polling of roster sizes. At leave time the awareness state
    // must already be cleared (removal happens before the event fires).
    let aClearedB: boolean | null = null;
    let bClearedA: boolean | null = null;
    a.provider.on("peer-leave", (peer) => {
      if (peer.awarenessId === b.provider.awareness.clientID) {
        aClearedB = !a.provider.awareness.getStates().has(peer.awarenessId);
      }
    });
    b.provider.on("peer-leave", (peer) => {
      if (peer.awarenessId === a.provider.awareness.clientID) {
        bClearedA = !b.provider.awareness.getStates().has(peer.awarenessId);
      }
    });

    // Network cut: A drops. A immediately stops claiming B is present, and
    // B learns A left via the server's presence-leave broadcast.
    a.transport.dropConnection();
    await waitFor(() => aClearedB !== null && bClearedA !== null);
    expect(Boolean(aClearedB)).toBe(true);
    expect(Boolean(bClearedA)).toBe(true);

    // A auto-reconnects (fresh server-side client, like a real socket).
    await waitFor(() => a.connection.state.type === "connected");

    // Roster rebuilds on both sides...
    await waitFor(() => a.provider.peers.size === 1 && b.provider.peers.size === 1);
    // ...and so do awareness states, in BOTH directions, without either side
    // touching its local state: A re-broadcasts its own state on reconnect
    // and awareness-requests B's.
    await waitFor(
      () =>
        a.provider.awareness.getStates().get(b.provider.awareness.clientID)?.user?.name === "Bob" &&
        b.provider.awareness.getStates().get(a.provider.awareness.clientID)?.user?.name === "Alice",
    );

    a.provider.destroy();
    b.provider.destroy();
    await server[Symbol.asyncDispose]();
  });

  it("server kills the presence of a ping-capable client that goes silent", async () => {
    // TTL 30ms, sweep every 15ms; the client heartbeats every 5ms.
    const server = makeServer({ clientTtlMs: 30 });
    const a = await connectProvider(server, {
      clientId: "A",
      userId: "user-a",
      heartbeatInterval: 5,
      maxReconnectAttempts: 0,
    });
    const b = await connectProvider(server, { clientId: "B", userId: "user-b" });

    a.provider.awareness.setLocalState({ user: { name: "Alice" } });
    await waitFor(
      () =>
        b.provider.peers.size === 1 &&
        b.provider.awareness.getStates().has(a.provider.awareness.clientID),
    );

    // A wedges: the connection stays up but pings stop (frozen tab,
    // half-open socket). It must survive well past the TTL first while
    // heartbeating, to prove the pings are what keeps it alive.
    await tick(60);
    expect(b.provider.peers.size).toBe(1);

    a.transport.heartbeatsEnabled = false;
    await waitFor(() => b.provider.peers.size === 0);

    // The dead client's awareness is cleared for peers, and the server
    // dropped its connection entirely.
    expect(b.provider.awareness.getStates().has(a.provider.awareness.clientID)).toBe(false);
    expect(a.connection.state.type).not.toBe("connected");

    // B never pinged (not ping-capable), so the sweep must NOT have touched
    // it: it still holds a live connection.
    expect(b.connection.state.type).toBe("connected");

    a.provider.destroy();
    b.provider.destroy();
    await server[Symbol.asyncDispose]();
  });

  it("heals a ghost peer via the periodic roster heartbeat", async () => {
    const server = makeServer();
    // presenceJoinGraceMs 0 so the reconcile removal applies immediately
    // (in production a real ghost is older than the 5s join grace).
    const a = await connectProvider(server, {
      clientId: "A",
      userId: "user-a",
      presenceJoinGraceMs: 0,
    });

    // Inject a join for a peer the server does not track (a lost-leave
    // ghost from the client's perspective).
    const session = server.getSession(`room/${DOC}`)!;
    expect(session).toBeDefined();
    await session.broadcastRpc("presenceJoin", {
      awarenessId: 424242,
      clientId: "ghost",
      userId: "user-ghost",
      data: {},
    });
    await waitFor(() => a.provider.peers.has(424242));
    a.provider.awareness.states.set(424242, { user: { name: "Ghost" } });

    const leaves: PresenceEvent[] = [];
    a.provider.on("peer-leave", (peer) => leaves.push(peer));

    // One maintenance tick: the roster heartbeat carries the truth (no
    // ghost), and the client reconciles it away.
    await runPresenceMaintenance(server.presenceRegistry, session);
    await waitFor(() => !a.provider.peers.has(424242));

    expect(leaves.map((p) => p.awarenessId)).toEqual([424242]);
    expect(a.provider.awareness.getStates().has(424242)).toBe(false);

    a.provider.destroy();
    await server[Symbol.asyncDispose]();
  });

  it("a new client's awareness request pulls existing peers' states immediately", async () => {
    const server = makeServer();
    const a = await connectProvider(server, { clientId: "A", userId: "user-a" });
    a.provider.awareness.setLocalState({ user: { name: "Alice" } });
    await tick();

    // B joins AFTER A set its state. Without the awareness-request on init,
    // B would only see A's cursor when A next changed it (up to y-protocols'
    // 15s renewal later).
    const b = await connectProvider(server, { clientId: "B", userId: "user-b" });
    await waitFor(
      () =>
        b.provider.awareness.getStates().get(a.provider.awareness.clientID)?.user?.name === "Alice",
    );

    a.provider.destroy();
    b.provider.destroy();
    await server[Symbol.asyncDispose]();
  });
});
