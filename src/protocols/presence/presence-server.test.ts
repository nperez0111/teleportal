import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Message, ServerContext } from "teleportal";
import { InMemoryPubSub, RpcMessage } from "teleportal";
import { decodeMessage } from "teleportal/protocol";
import { Server } from "../../server/server";
import { Session } from "../../server/session";
import { getPresenceRpcHandlers, runPresenceMaintenance } from "./server";
import type { PresenceEntry } from "./methods";

class MockClient<Context extends ServerContext> {
  public sentMessages: Message<Context>[] = [];

  constructor(public id: string) {}

  async send(message: Message<Context>) {
    this.sentMessages.push(message);
  }

  destroy() {}

  pushes(method: string): unknown[] {
    return this.sentMessages
      .filter(
        (m): m is RpcMessage<Context> =>
          m.type === "rpc" &&
          (m as RpcMessage<Context>).rpcMethod === method &&
          (m as RpcMessage<Context>).requestType === "response" &&
          (m as RpcMessage<Context>).originalRequestId === undefined,
      )
      .map((m) => (m.payload as { type: "success"; payload: unknown }).payload);
  }
}

const storageStub = {
  type: "document-storage",
  storageType: "unencrypted",
  fileStorage: undefined,
  milestoneStorage: undefined,
  handleSyncStep1: async () => {
    throw new Error("not used");
  },
  handleSyncStep2: async () => {},
  handleUpdate: async () => {},
  getDocument: async () => null,
  writeDocumentMetadata: async () => {},
  getDocumentMetadata: async () => ({ createdAt: 0, updatedAt: 0, encrypted: false }),
  deleteDocument: async () => {},
  transaction: <T>(_id: string, cb: () => Promise<T>) => cb(),
  addFileToDocument: async () => {},
  removeFileFromDocument: async () => {},
} as any;

function announceMessage(
  method: "presence.announce" | "presence.unannounce",
  awarenessId: number,
  userId: string,
): RpcMessage<ServerContext> {
  return new RpcMessage<ServerContext>(
    "test-doc",
    { type: "success", payload: { awarenessId, nonce: Math.random() } },
    method,
    "request",
    undefined,
    { userId } as ServerContext,
    false,
  );
}

function forgedPush(method: string, payload: unknown): RpcMessage<ServerContext> {
  return new RpcMessage<ServerContext>(
    "test-doc",
    { type: "success", payload },
    method,
    "response",
    undefined,
    {} as ServerContext,
    false,
  );
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("presence protocol server", () => {
  let pubSub: InMemoryPubSub;
  let disposables: Array<() => Promise<unknown>>;

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    disposables = [];
  });

  afterEach(async () => {
    for (const dispose of disposables.reverse()) {
      await dispose();
    }
    await pubSub[Symbol.asyncDispose]();
  });

  async function makeNode(
    nodeId: string,
    config?: {
      presenceTtlMs?: number;
      rosterRefreshMinIntervalMs?: number;
      getPresenceData?: (
        context: ServerContext,
      ) => Record<string, unknown> | Promise<Record<string, unknown>>;
    },
  ) {
    // One registry per node, as in a real deployment. heartbeatIntervalMs: 0
    // disables the timer — tests drive ticks via runPresenceMaintenance.
    // rosterRefreshMinIntervalMs: 0 disables refresh throttling unless a test
    // exercises it explicitly.
    const registry = getPresenceRpcHandlers({
      heartbeatIntervalMs: 0,
      presenceTtlMs: config?.presenceTtlMs ?? 90_000,
      rosterRefreshMinIntervalMs: config?.rosterRefreshMinIntervalMs ?? 0,
      getPresenceData:
        config?.getPresenceData ?? ((context) => ({ name: `name-of-${context.userId}` })),
    });
    const server = new Server<ServerContext>({
      storage: async () => {
        throw new Error("not used");
      },
      rpcHandlers: registry,
    });
    const session = new Session<ServerContext>({
      documentId: "test-doc",
      namespacedDocumentId: "test-doc",
      id: `session-${nodeId}`,
      encrypted: false,
      storage: storageStub,
      pubSub,
      nodeId,
      onCleanupScheduled: () => {},
      rpcHandlers: registry,
      server,
    });
    await session.load();
    // What the real server does when the first client opens the document.
    await server.call("session-open", {
      session,
      documentId: "test-doc",
      namespacedDocumentId: "test-doc",
      encrypted: false,
      context: {} as ServerContext,
    });
    disposables.push(async () => {
      await session[Symbol.asyncDispose]();
      await server[Symbol.asyncDispose]();
    });
    return { registry, server, session };
  }

  it("replies to an announce with the roster, including the announcer's own entry", async () => {
    const { session } = await makeNode("node-a");
    const client = new MockClient<ServerContext>("client-a");
    session.addClient(client as any);

    await session.apply(announceMessage("presence.announce", 11, "user-a"), client as any);

    const rosters = client.pushes("presence.roster") as Array<{ clients: PresenceEntry[] }>;
    expect(rosters).toHaveLength(1);
    expect(rosters[0].clients).toEqual([
      { awarenessId: 11, clientId: "client-a", userId: "user-a", data: { name: "name-of-user-a" } },
    ]);
    // The request itself is answered.
    const responses = client.sentMessages.filter(
      (m) => m.type === "rpc" && (m as RpcMessage<ServerContext>).originalRequestId !== undefined,
    );
    expect(responses).toHaveLength(1);
  });

  it("notifies already-announced peers of a newcomer, but not un-announced connections", async () => {
    const { session } = await makeNode("node-a");
    const announced = new MockClient<ServerContext>("client-a");
    const silent = new MockClient<ServerContext>("client-silent");
    const newcomer = new MockClient<ServerContext>("client-b");
    session.addClient(announced as any);
    session.addClient(silent as any);
    session.addClient(newcomer as any);

    await session.apply(announceMessage("presence.announce", 11, "user-a"), announced as any);
    await session.apply(announceMessage("presence.announce", 22, "user-b"), newcomer as any);

    const joins = announced.pushes("presence.join") as PresenceEntry[];
    expect(joins).toHaveLength(1);
    expect(joins[0].awarenessId).toBe(22);
    expect(silent.pushes("presence.join")).toHaveLength(0);
    // The newcomer's roster carries both entries.
    const rosters = newcomer.pushes("presence.roster") as Array<{ clients: PresenceEntry[] }>;
    expect(rosters[0].clients.map((c) => c.awarenessId).sort()).toEqual([11, 22]);
  });

  it("broadcasts an unannounce as a leave to everyone, including the sender's connection", async () => {
    const { session } = await makeNode("node-a");
    const clientA = new MockClient<ServerContext>("client-a");
    const clientB = new MockClient<ServerContext>("client-b");
    session.addClient(clientA as any);
    session.addClient(clientB as any);
    await session.apply(announceMessage("presence.announce", 11, "user-a"), clientA as any);
    await session.apply(announceMessage("presence.announce", 22, "user-b"), clientB as any);

    await session.apply(announceMessage("presence.unannounce", 11, "user-a"), clientA as any);

    const leavesAtB = clientB.pushes("presence.leave") as PresenceEntry[];
    expect(leavesAtB.map((l) => l.awarenessId)).toEqual([11]);
    // Sibling tabs on the sender's own SharedWorker connection need it too.
    const leavesAtA = clientA.pushes("presence.leave") as PresenceEntry[];
    expect(leavesAtA.map((l) => l.awarenessId)).toEqual([11]);
  });

  it("broadcasts a leave when a client disconnects (client-leave event)", async () => {
    const { session } = await makeNode("node-a");
    const clientA = new MockClient<ServerContext>("client-a");
    const clientB = new MockClient<ServerContext>("client-b");
    session.addClient(clientA as any);
    session.addClient(clientB as any);
    await session.apply(announceMessage("presence.announce", 11, "user-a"), clientA as any);

    session.removeClient("client-a");

    await waitFor(() => clientB.pushes("presence.leave").length === 1);
    const leaves = clientB.pushes("presence.leave") as PresenceEntry[];
    expect(leaves[0]).toEqual({
      awarenessId: 11,
      clientId: "client-a",
      userId: "user-a",
      data: { name: "name-of-user-a" },
    });
  });

  it("does not create a ghost peer when the client leaves during an async getPresenceData", async () => {
    // Gate only the leaver's presence-data lookup so the observer's announce
    // completes synchronously and can then observe (or not) the newcomer.
    let releasePresenceData!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePresenceData = resolve;
    });
    const { registry, session } = await makeNode("node-a", {
      getPresenceData: async (context) => {
        if (context.userId === "user-a") {
          await gate;
        }
        return { name: `name-of-${context.userId}` };
      },
    });
    const leaver = new MockClient<ServerContext>("client-a");
    const observer = new MockClient<ServerContext>("client-b");
    session.addClient(leaver as any);
    session.addClient(observer as any);
    await session.apply(announceMessage("presence.announce", 22, "user-b"), observer as any);

    // Start the leaver's announce; it suspends inside the gated getPresenceData.
    const announcePromise = session.apply(
      announceMessage("presence.announce", 11, "user-a"),
      leaver as any,
    );
    // The connection drops while the announce is still suspended — client-leave
    // fires now, before any entry for this client exists.
    session.removeClient("client-a");
    // Let getPresenceData resolve so the announce handler resumes.
    releasePresenceData();
    await announcePromise;

    // The handler must detect the client already left and bail: no ghost join
    // for awarenessId 11 is broadcast to the observer, and nothing lingers.
    expect(observer.pushes("presence.join")).toHaveLength(0);
    await runPresenceMaintenance(registry, session);
    const rosters = observer.pushes("presence.roster") as Array<{ clients: PresenceEntry[] }>;
    for (const roster of rosters) {
      expect(roster.clients.map((c) => c.awarenessId)).not.toContain(11);
    }
  });

  it("transfers an awarenessId re-announced from a new connection without a leave", async () => {
    const { session } = await makeNode("node-a");
    const oldConn = new MockClient<ServerContext>("client-old");
    const newConn = new MockClient<ServerContext>("client-new");
    const observer = new MockClient<ServerContext>("client-observer");
    session.addClient(oldConn as any);
    session.addClient(newConn as any);
    session.addClient(observer as any);
    await session.apply(announceMessage("presence.announce", 33, "user-x"), oldConn as any);
    await session.apply(announceMessage("presence.announce", 44, "user-o"), observer as any);

    await session.apply(announceMessage("presence.announce", 33, "user-x"), newConn as any);
    // The old connection's eventual disconnect must not clobber the live presence.
    session.removeClient("client-old");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(observer.pushes("presence.leave")).toHaveLength(0);
  });

  it("ignores forged server-authored pushes from clients", async () => {
    const { session } = await makeNode("node-a");
    const attacker = new MockClient<ServerContext>("client-attacker");
    const victimPeer = new MockClient<ServerContext>("client-peer");
    session.addClient(attacker as any);
    session.addClient(victimPeer as any);
    await session.apply(announceMessage("presence.announce", 22, "user-b"), victimPeer as any);

    await session.apply(
      forgedPush("presence.leave", {
        awarenessId: 22,
        clientId: "client-peer",
        userId: "user-b",
        data: {},
      }),
      attacker as any,
    );

    expect(victimPeer.pushes("presence.leave")).toHaveLength(0);
  });

  describe("cross-node", () => {
    it("propagates joins to other nodes and reconciles rosters", async () => {
      const nodeA = await makeNode("node-a");
      const nodeB = await makeNode("node-b");
      const localClient = new MockClient<ServerContext>("client-a");
      const remoteClient = new MockClient<ServerContext>("client-b");
      nodeA.session.addClient(localClient as any);
      nodeB.session.addClient(remoteClient as any);
      await nodeB.session.apply(
        announceMessage("presence.announce", 22, "user-b"),
        remoteClient as any,
      );

      await nodeA.session.apply(
        announceMessage("presence.announce", 11, "user-a"),
        localClient as any,
      );

      // Node B's local client learns about the node-A newcomer via the
      // replicated join push.
      await waitFor(() => remoteClient.pushes("presence.join").length === 1);
      const join = (remoteClient.pushes("presence.join") as PresenceEntry[])[0];
      expect(join.awarenessId).toBe(11);

      // A maintenance tick on node B pushes the combined roster (both peers)
      // to its local clients.
      await runPresenceMaintenance(nodeB.registry, nodeB.session);
      const rosters = remoteClient.pushes("presence.roster") as Array<{
        clients: PresenceEntry[];
      }>;
      const lastRoster = rosters[rosters.length - 1];
      expect(lastRoster.clients.map((c) => c.awarenessId).sort()).toEqual([11, 22]);
    });

    it("does not replicate a forged push to other nodes", async () => {
      const nodeA = await makeNode("node-a");
      const nodeB = await makeNode("node-b");
      const attacker = new MockClient<ServerContext>("client-attacker");
      const victimPeer = new MockClient<ServerContext>("client-peer");
      nodeA.session.addClient(attacker as any);
      nodeB.session.addClient(victimPeer as any);
      await nodeB.session.apply(
        announceMessage("presence.announce", 22, "user-b"),
        victimPeer as any,
      );

      await nodeA.session.apply(
        forgedPush("presence.leave", {
          awarenessId: 22,
          clientId: "client-peer",
          userId: "user-b",
          data: {},
        }),
        attacker as any,
      );

      // The forged leave must not surface on the other node: were it
      // replicated, node B would receive it as a trusted node-to-node push
      // and forward it to its clients.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(victimPeer.pushes("presence.leave")).toHaveLength(0);
    });

    it("learns the cross-node roster on session open without waiting for a heartbeat", async () => {
      const nodeA = await makeNode("node-a");
      const localClient = new MockClient<ServerContext>("client-a");
      nodeA.session.addClient(localClient as any);
      await nodeA.session.apply(
        announceMessage("presence.announce", 11, "user-a"),
        localClient as any,
      );

      // Node B opens the session *after* node A's client announced: the
      // join push is long gone, and no maintenance tick runs in this test —
      // only the on-open roster request can teach node B about the peer.
      const nodeB = await makeNode("node-b");
      const remoteClient = new MockClient<ServerContext>("client-b");
      nodeB.session.addClient(remoteClient as any);

      const deadline = Date.now() + 500;
      let known: number[] = [];
      while (Date.now() < deadline) {
        await nodeB.session.apply(
          announceMessage("presence.announce", 22, "user-b"),
          remoteClient as any,
        );
        const rosters = remoteClient.pushes("presence.roster") as Array<{
          clients: PresenceEntry[];
        }>;
        known = rosters[rosters.length - 1].clients.map((c) => c.awarenessId).sort();
        if (known.includes(11)) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(known).toEqual([11, 22]);
    });

    it("re-learns peers after a replication gap via a roster request", async () => {
      const nodeA = await makeNode("node-a");
      const nodeB = await makeNode("node-b", { presenceTtlMs: 20 });
      const localClient = new MockClient<ServerContext>("client-a");
      const remoteClient = new MockClient<ServerContext>("client-b");
      nodeA.session.addClient(localClient as any);
      nodeB.session.addClient(remoteClient as any);
      await nodeB.session.apply(
        announceMessage("presence.announce", 22, "user-b"),
        remoteClient as any,
      );
      await nodeA.session.apply(
        announceMessage("presence.announce", 11, "user-a"),
        localClient as any,
      );
      await waitFor(() => remoteClient.pushes("presence.join").length === 1);

      // Node A goes silent past node B's TTL: node B forgets its peer.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await runPresenceMaintenance(nodeB.registry, nodeB.session);
      await waitFor(() => remoteClient.pushes("presence.leave").length === 1);

      // A replication gap makes node B ask the network for fresh rosters;
      // node A answers and the peer comes back — no heartbeat tick needed.
      await nodeB.session.call("replication-gap", {
        documentId: "test-doc",
        namespacedDocumentId: "test-doc",
        sessionId: nodeB.session.id,
      });
      await waitFor(() => remoteClient.pushes("presence.join").length === 2);
      const rejoin = (remoteClient.pushes("presence.join") as PresenceEntry[])[1];
      expect(rejoin.awarenessId).toBe(11);
    });

    it("keeps presence alive when a client reconnects to another node before its old connection dies", async () => {
      const nodeA = await makeNode("node-a");
      const nodeB = await makeNode("node-b");
      const observerA = new MockClient<ServerContext>("observer-a");
      const observerB = new MockClient<ServerContext>("observer-b");
      const oldConn = new MockClient<ServerContext>("conn-old");
      const newConn = new MockClient<ServerContext>("conn-new");
      nodeA.session.addClient(observerA as any);
      nodeA.session.addClient(oldConn as any);
      nodeB.session.addClient(observerB as any);
      nodeB.session.addClient(newConn as any);
      await nodeA.session.apply(
        announceMessage("presence.announce", 1, "user-oa"),
        observerA as any,
      );
      await nodeB.session.apply(
        announceMessage("presence.announce", 2, "user-ob"),
        observerB as any,
      );
      // Client X (awarenessId 33) is on node A...
      await nodeA.session.apply(announceMessage("presence.announce", 33, "user-x"), oldConn as any);
      await waitFor(() =>
        (observerB.pushes("presence.join") as PresenceEntry[]).some((j) => j.awarenessId === 33),
      );

      // ...then reconnects to node B while the old connection lingers on A.
      await nodeB.session.apply(announceMessage("presence.announce", 33, "user-x"), newConn as any);
      await waitFor(() => {
        const rosters = observerB.pushes("presence.roster");
        return (
          rosters.length > 0 || (observerA.pushes("presence.join") as PresenceEntry[]).length >= 1
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      // The old socket finally dies on node A: its leave must not clobber the
      // live presence now owned by node B.
      nodeA.session.removeClient("conn-old");
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(
        (observerA.pushes("presence.leave") as PresenceEntry[]).filter((l) => l.awarenessId === 33),
      ).toHaveLength(0);
      expect(
        (observerB.pushes("presence.leave") as PresenceEntry[]).filter((l) => l.awarenessId === 33),
      ).toHaveLength(0);

      // Even after node A advertises its 33-less roster, reconciliation on B
      // must not emit a leave for the locally-owned awarenessId.
      await runPresenceMaintenance(nodeA.registry, nodeA.session);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(
        (observerB.pushes("presence.leave") as PresenceEntry[]).filter((l) => l.awarenessId === 33),
      ).toHaveLength(0);
    });

    it("delivers a re-join within the replication dedupe window (announce → unannounce → re-announce)", async () => {
      const nodeA = await makeNode("node-a");
      const nodeB = await makeNode("node-b");
      const localClient = new MockClient<ServerContext>("client-a");
      const remoteClient = new MockClient<ServerContext>("client-b");
      nodeA.session.addClient(localClient as any);
      nodeB.session.addClient(remoteClient as any);
      await nodeB.session.apply(
        announceMessage("presence.announce", 22, "user-b"),
        remoteClient as any,
      );

      await nodeA.session.apply(
        announceMessage("presence.announce", 11, "user-a"),
        localClient as any,
      );
      await waitFor(() => remoteClient.pushes("presence.join").length === 1);
      await nodeA.session.apply(
        announceMessage("presence.unannounce", 11, "user-a"),
        localClient as any,
      );
      await waitFor(() => remoteClient.pushes("presence.leave").length === 1);

      // The re-announce produces a byte-identical presenceJoin push; replication
      // dedup must not swallow it (qos.dedupe: false on join/leave).
      await nodeA.session.apply(
        announceMessage("presence.announce", 11, "user-a"),
        localClient as any,
      );
      await waitFor(() => remoteClient.pushes("presence.join").length === 2);
    });

    it("coalesces roster refreshes within the configured window", async () => {
      const requestLog: string[] = [];
      await pubSub.subscribe("document/test-doc", (binary, sourceId) => {
        const decoded = decodeMessage(binary);
        if (decoded.type === "rpc" && decoded.rpcMethod === "presence.rosterRequest") {
          requestLog.push(sourceId);
        }
      });
      const nodeB = await makeNode("node-b", { rosterRefreshMinIntervalMs: 30 });
      // The session-open refresh consumed the window; wait it out so the
      // storm below starts fresh.
      await new Promise((resolve) => setTimeout(resolve, 35));
      const before = requestLog.filter((s) => s === "node-b").length;

      // A gap storm (e.g. NATS firing onGap for every topic on one purge)
      // must collapse to a single roster request.
      for (let i = 0; i < 5; i++) {
        await nodeB.session.call("replication-gap", {
          documentId: "test-doc",
          namespacedDocumentId: "test-doc",
          sessionId: nodeB.session.id,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(requestLog.filter((s) => s === "node-b").length - before).toBe(1);
    });

    it("suppresses repeated roster answers within the configured window", async () => {
      const rosterLog: string[] = [];
      await pubSub.subscribe("document/test-doc", (binary, sourceId) => {
        const decoded = decodeMessage(binary);
        if (decoded.type === "rpc" && decoded.rpcMethod === "presence.roster") {
          rosterLog.push(sourceId);
        }
      });
      const nodeA = await makeNode("node-a", { rosterRefreshMinIntervalMs: 30 });
      const localClient = new MockClient<ServerContext>("client-a");
      nodeA.session.addClient(localClient as any);
      await nodeA.session.apply(
        announceMessage("presence.announce", 11, "user-a"),
        localClient as any,
      );

      const rosterRequest = () =>
        new RpcMessage<ServerContext>(
          "test-doc",
          { type: "success", payload: {} },
          "presence.rosterRequest",
          "response",
          undefined,
          {} as ServerContext,
          false,
        );
      // A burst of requests from other nodes is answered once...
      await pubSub.publish("document/test-doc", rosterRequest().encoded, "node-x");
      await pubSub.publish("document/test-doc", rosterRequest().encoded, "node-y");
      await waitFor(() => rosterLog.filter((s) => s === "node-a").length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(rosterLog.filter((s) => s === "node-a")).toHaveLength(1);

      // ...and answered again once the window has passed.
      await new Promise((resolve) => setTimeout(resolve, 35));
      await pubSub.publish("document/test-doc", rosterRequest().encoded, "node-x");
      await waitFor(() => rosterLog.filter((s) => s === "node-a").length === 2);
    });

    it("heals a lost join via the periodic node roster (dedupe-exempt) and expires crashed nodes", async () => {
      const nodeA = await makeNode("node-a", { presenceTtlMs: 20 });
      const nodeB = await makeNode("node-b", { presenceTtlMs: 20 });
      const localClient = new MockClient<ServerContext>("client-a");
      const remoteClient = new MockClient<ServerContext>("client-b");
      nodeA.session.addClient(localClient as any);
      nodeB.session.addClient(remoteClient as any);
      await nodeB.session.apply(
        announceMessage("presence.announce", 22, "user-b"),
        remoteClient as any,
      );
      await nodeA.session.apply(
        announceMessage("presence.announce", 11, "user-a"),
        localClient as any,
      );
      await waitFor(() => remoteClient.pushes("presence.join").length === 1);

      // Two identical node-roster publishes in a row: the second must NOT be
      // dropped by replication dedup (qos.dedupe: false on presenceRoster) —
      // node B's lastSeen for node A must keep refreshing.
      await runPresenceMaintenance(nodeA.registry, nodeA.session);
      await runPresenceMaintenance(nodeA.registry, nodeA.session);
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Node A goes silent past the TTL: node B expires it and tells clients.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await runPresenceMaintenance(nodeB.registry, nodeB.session);
      await waitFor(() => remoteClient.pushes("presence.leave").length === 1);
      const leave = (remoteClient.pushes("presence.leave") as PresenceEntry[])[0];
      expect(leave.awarenessId).toBe(11);

      // ...and the combined roster no longer carries the expired peer.
      const rosters = remoteClient.pushes("presence.roster") as Array<{
        clients: PresenceEntry[];
      }>;
      const lastRoster = rosters[rosters.length - 1];
      expect(lastRoster.clients.map((c) => c.awarenessId)).toEqual([22]);
    });
  });
});
