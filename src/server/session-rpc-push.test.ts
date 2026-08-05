import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Message, ServerContext } from "teleportal";
import { decodeMessage, InMemoryPubSub, RpcMessage } from "teleportal";
import type { RpcHandlerRegistry } from "teleportal/protocol";
import { Server } from "./server";
import { Session } from "./session";

class MockClient<Context extends ServerContext> {
  public sentMessages: Message<Context>[] = [];

  constructor(public id: string) {}

  async send(message: Message<Context>) {
    this.sentMessages.push(message);
  }
}

function createMockServer(): Server<ServerContext> {
  return new Server<ServerContext>({
    storage: async () => {
      throw new Error("Not implemented in mock");
    },
  });
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

function createSession(args: {
  pubSub: InMemoryPubSub;
  nodeId: string;
  rpcHandlers?: RpcHandlerRegistry;
  server: Server<ServerContext>;
}): Session<ServerContext> {
  return new Session({
    documentId: "test-doc",
    namespacedDocumentId: "test-doc",
    id: `session-${args.nodeId}`,
    encrypted: false,
    storage: storageStub,
    pubSub: args.pubSub,
    nodeId: args.nodeId,
    onCleanupScheduled: () => {},
    rpcHandlers: args.rpcHandlers,
    server: args.server,
  });
}

function rpcPush(method: string, payload: unknown): RpcMessage<ServerContext> {
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

/** Poll until `condition` returns true (event-driven wait, no fixed sleeps). */
async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("Session RPC push primitives", () => {
  let pubSub: InMemoryPubSub;
  let mockServer: Server<ServerContext>;
  let sessions: Session<ServerContext>[];

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    mockServer = createMockServer();
    sessions = [];
  });

  afterEach(async () => {
    for (const session of sessions) {
      await session[Symbol.asyncDispose]();
    }
    await pubSub[Symbol.asyncDispose]();
  });

  async function makeSession(nodeId: string, rpcHandlers?: RpcHandlerRegistry) {
    const session = createSession({ pubSub, nodeId, rpcHandlers, server: mockServer });
    sessions.push(session);
    await session.load();
    return session;
  }

  describe("broadcastRpc / sendRpcToClient", () => {
    it("broadcasts a push to all local clients except the excluded one", async () => {
      const session = await makeSession("node-a");
      const clientA = new MockClient<ServerContext>("client-a");
      const clientB = new MockClient<ServerContext>("client-b");
      session.addClient(clientA as any);
      session.addClient(clientB as any);

      await session.broadcastRpc("testPush", { n: 1 }, { excludeClientId: "client-a" });

      expect(clientA.sentMessages).toHaveLength(0);
      expect(clientB.sentMessages).toHaveLength(1);
      const message = clientB.sentMessages[0] as RpcMessage<ServerContext>;
      expect(message.type).toBe("rpc");
      expect(message.rpcMethod).toBe("testPush");
      expect(message.requestType).toBe("response");
      expect(message.originalRequestId).toBeUndefined();
      expect(message.payload).toEqual({ type: "success", payload: { n: 1 } });
    });

    it("sends a push to a single client by id", async () => {
      const session = await makeSession("node-a");
      const clientA = new MockClient<ServerContext>("client-a");
      const clientB = new MockClient<ServerContext>("client-b");
      session.addClient(clientA as any);
      session.addClient(clientB as any);

      await session.sendRpcToClient("client-b", "testPush", { n: 2 });

      expect(clientA.sentMessages).toHaveLength(0);
      expect(clientB.sentMessages).toHaveLength(1);
    });

    it("stamps the method's declared QoS onto the message", async () => {
      const handlers: RpcHandlerRegistry = {
        bestEffortPush: {
          qos: { durability: "ephemeral", replicate: true, ack: false, dedupe: true },
        },
      };
      const session = await makeSession("node-a", handlers);
      const client = new MockClient<ServerContext>("client-a");
      session.addClient(client as any);

      await session.broadcastRpc("bestEffortPush", { n: 3 });

      const message = client.sentMessages[0] as RpcMessage<ServerContext>;
      expect(message.requiresAck).toBe(false);
      expect(message.durability).toBe("ephemeral");
    });
  });

  describe("cross-node replication", () => {
    it("dispatches a replicated push to the method's pushHandler and forwards by default", async () => {
      const received: Array<{ payload: unknown; sourceNodeId?: string; clientId?: string }> = [];
      const handlers: RpcHandlerRegistry = {
        rosterPush: {
          pushHandler: async (payload, ctx) => {
            received.push({
              payload,
              sourceNodeId: ctx.sourceNodeId,
              clientId: ctx.clientId,
            });
          },
        },
      };

      const sessionA = await makeSession("node-a");
      const sessionB = await makeSession("node-b", handlers);
      const remoteClient = new MockClient<ServerContext>("remote-client");
      sessionB.addClient(remoteClient as any);

      await sessionA.broadcastRpc("rosterPush", { members: ["x"] });

      await waitFor(() => received.length === 1);
      expect(received[0].payload).toEqual({ members: ["x"] });
      expect(received[0].sourceNodeId).toBe("node-a");
      expect(received[0].clientId).toBeUndefined();
      // Default: the push is also relayed to node B's local clients.
      await waitFor(() => remoteClient.sentMessages.length === 1);
    });

    it("suppresses local relay when the pushHandler returns forwardToLocalClients: false", async () => {
      let handled = 0;
      const handlers: RpcHandlerRegistry = {
        rosterPush: {
          pushHandler: async () => {
            handled++;
            return { forwardToLocalClients: false };
          },
        },
      };

      const sessionA = await makeSession("node-a");
      const sessionB = await makeSession("node-b", handlers);
      const remoteClient = new MockClient<ServerContext>("remote-client");
      sessionB.addClient(remoteClient as any);

      await sessionA.broadcastRpc("rosterPush", { members: ["x"] });

      await waitFor(() => handled === 1);
      expect(remoteClient.sentMessages).toHaveLength(0);
    });

    it("relays a replicated push with no registered handler to local clients (attributionPush regression)", async () => {
      const sessionA = await makeSession("node-a");
      const sessionB = await makeSession("node-b");
      const remoteClient = new MockClient<ServerContext>("remote-client");
      sessionB.addClient(remoteClient as any);

      await sessionA.broadcastRpc("attributionPush", { contentMap: "opaque" });

      await waitFor(() => remoteClient.sentMessages.length === 1);
      const message = remoteClient.sentMessages[0] as RpcMessage<ServerContext>;
      expect(message.rpcMethod).toBe("attributionPush");
    });

    it("does not publish when the method declares replicate: false", async () => {
      const handlers: RpcHandlerRegistry = {
        localOnlyPush: {
          qos: { durability: "ephemeral", replicate: false, ack: true, dedupe: true },
        },
      };
      const sessionA = await makeSession("node-a", handlers);
      const sessionB = await makeSession("node-b");
      const localClient = new MockClient<ServerContext>("local-client");
      const remoteClient = new MockClient<ServerContext>("remote-client");
      sessionA.addClient(localClient as any);
      sessionB.addClient(remoteClient as any);

      await sessionA.broadcastRpc("localOnlyPush", { n: 4 });
      // Give the pub/sub bus a beat: absence must not be a race artifact.
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(localClient.sentMessages).toHaveLength(1);
      expect(remoteClient.sentMessages).toHaveLength(0);
    });

    it("publishRpc reaches other nodes without a local broadcast", async () => {
      let handled = 0;
      const handlers: RpcHandlerRegistry = {
        snapshotPush: {
          pushHandler: async () => {
            handled++;
            return { forwardToLocalClients: false };
          },
        },
      };
      const sessionA = await makeSession("node-a");
      await makeSession("node-b", handlers);
      const localClient = new MockClient<ServerContext>("local-client");
      sessionA.addClient(localClient as any);

      await sessionA.publishRpc("snapshotPush", { full: true });

      await waitFor(() => handled === 1);
      expect(localClient.sentMessages).toHaveLength(0);
    });
  });

  describe("dedup", () => {
    it("drops a redelivery of the same message (TtlDedupe)", async () => {
      // What dedup is actually for: one authored message arriving twice, e.g. a durable
      // backend redelivering after a blip. Both copies carry the same nonce, so they hash
      // to the same id and the second is dropped.
      let handled = 0;
      const handlers: RpcHandlerRegistry = {
        dedupedPush: {
          pushHandler: async () => {
            handled++;
            return { forwardToLocalClients: false };
          },
        },
      };
      await makeSession("node-b", handlers);

      const push = rpcPush("dedupedPush", { same: true });
      await pubSub.publish("document/test-doc", push.encoded, "node-a");
      await pubSub.publish("document/test-doc", push.encoded, "node-a");

      await waitFor(() => handled >= 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(handled).toBe(1);
    });

    it("applies two separately authored pushes with identical payloads", async () => {
      // These are two distinct events that happen to carry the same payload — a presence
      // roster republished unchanged, say. Each is authored with its own nonce, so they no
      // longer collide inside the dedup window and neither needs a `dedupe: false` opt-out.
      let handled = 0;
      const handlers: RpcHandlerRegistry = {
        rosterPush: {
          pushHandler: async () => {
            handled++;
            return { forwardToLocalClients: false };
          },
        },
      };
      const sessionA = await makeSession("node-a");
      await makeSession("node-b", handlers);

      await sessionA.broadcastRpc("rosterPush", { same: true });
      await sessionA.broadcastRpc("rosterPush", { same: true });

      await waitFor(() => handled === 2);
    });
  });

  describe("client-authored pushes", () => {
    it("relays a local client's push to peers but does NOT replicate it by default", async () => {
      const received: Array<{ clientId?: string; sourceNodeId?: string }> = [];
      const handlers: RpcHandlerRegistry = {
        clientPush: {
          pushHandler: async (_payload, ctx) => {
            received.push({ clientId: ctx.clientId, sourceNodeId: ctx.sourceNodeId });
          },
        },
      };

      const sessionA = await makeSession("node-a", handlers);
      const sessionB = await makeSession("node-b");
      const sender = new MockClient<ServerContext>("sender");
      const peer = new MockClient<ServerContext>("peer");
      const remoteClient = new MockClient<ServerContext>("remote-client");
      sessionA.addClient(sender as any);
      sessionA.addClient(peer as any);
      sessionB.addClient(remoteClient as any);

      await sessionA.apply(rpcPush("clientPush", { hello: true }), sender as any);

      // Local pushHandler sees the server-assigned sender id.
      expect(received).toHaveLength(1);
      expect(received[0].clientId).toBe("sender");
      expect(received[0].sourceNodeId).toBeUndefined();
      // Peers on the same node get it (sender excluded)...
      expect(sender.sentMessages).toHaveLength(0);
      expect(peer.sentMessages).toHaveLength(1);
      // ...but replication is opt-in: a client-authored push must not enter
      // the trusted node-to-node plane unless the handler vouches for it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(remoteClient.sentMessages).toHaveLength(0);
    });

    it("never replicates a client push for an unregistered method (no handler to vouch)", async () => {
      const sessionA = await makeSession("node-a");
      const sessionB = await makeSession("node-b");
      const sender = new MockClient<ServerContext>("sender");
      const peer = new MockClient<ServerContext>("peer");
      const remoteClient = new MockClient<ServerContext>("remote-client");
      sessionA.addClient(sender as any);
      sessionA.addClient(peer as any);
      sessionB.addClient(remoteClient as any);

      await sessionA.apply(rpcPush("adHocPush", { hello: true }), sender as any);

      // The historical default relay to same-node peers is preserved...
      expect(peer.sentMessages).toHaveLength(1);
      // ...but a node with no registered guard must not launder the push into
      // a trusted node-to-node message on other nodes.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(remoteClient.sentMessages).toHaveLength(0);
    });

    it("replicates a client push when the pushHandler explicitly opts in", async () => {
      const handlers: RpcHandlerRegistry = {
        vouchedPush: {
          pushHandler: async () => ({ replicate: true }),
        },
      };

      const sessionA = await makeSession("node-a", handlers);
      const sessionB = await makeSession("node-b");
      const sender = new MockClient<ServerContext>("sender");
      const remoteClient = new MockClient<ServerContext>("remote-client");
      sessionA.addClient(sender as any);
      sessionB.addClient(remoteClient as any);

      await sessionA.apply(rpcPush("vouchedPush", { hello: true }), sender as any);

      await waitFor(() => remoteClient.sentMessages.length === 1);
    });

    it("publishes a vouched client push on the lane its method declares", async () => {
      const handlers: RpcHandlerRegistry = {
        vouchedPush: {
          pushHandler: async () => ({ replicate: true }),
          qos: { durability: "ephemeral", replicate: true, ack: true, dedupe: true },
        },
      };

      const session = await makeSession("node-a", handlers);
      const sender = new MockClient<ServerContext>("sender");
      session.addClient(sender as any);

      const lanes: Array<boolean | undefined> = [];
      const publish = pubSub.publish.bind(pubSub);
      pubSub.publish = (topic, message, sourceId, options) => {
        lanes.push(options?.ephemeral);
        return publish(topic, message, sourceId, options);
      };

      // Durability never travels the wire, so a decoded client push carries no
      // durability of its own — the authoring node must re-derive it from the
      // method definition before publishing, or an ephemeral push (a periodic
      // roster, say) would be persisted and replayed as if it were a document
      // update.
      const wire = decodeMessage(
        rpcPush("vouchedPush", { hello: true }).encoded,
      ) as RpcMessage<ServerContext>;
      await session.apply(wire, sender as any);

      await waitFor(() => lanes.length > 0);
      expect(lanes).toEqual([true]);
    });
  });
});
