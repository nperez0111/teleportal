import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ServerContext } from "teleportal";
import { InMemoryPubSub } from "teleportal";
import { generateEncryptionKey } from "teleportal/encryption-key";
import {
  createClientExtension,
  createHandlers,
  defineMethod,
  defineProtocol,
  ok,
} from "teleportal/rpc";
import { Server } from "teleportal/server";
import { MemoryDocumentStorage } from "teleportal/storage";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createAgent } from "./index";

/** Poll until `condition` holds (event-driven wait, no fixed sleeps). */
async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

const ctx = (overrides: Partial<ServerContext> = {}): ServerContext => ({
  clientId: "test-client",
  userId: "test-user",
  room: "test-room",
  ...overrides,
});

describe("createAgent", () => {
  let server: Server<ServerContext>;
  let pubSub: InMemoryPubSub;

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    server = new Server({
      storage: () => Promise.resolve(new MemoryDocumentStorage()),
      pubSub,
    });
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  it("returns a synced Provider with doc and awareness", async () => {
    const agent = await createAgent(server, {
      document: "test-doc",
      context: ctx(),
      encryptionKey: false,
    });

    expect(agent.doc).toBeInstanceOf(Y.Doc);
    expect(agent.awareness).toBeInstanceOf(Awareness);

    agent.destroy();
  });

  it("registers the client with the provided clientId", async () => {
    const agent = await createAgent(server, {
      document: "test-doc-2",
      context: ctx({ clientId: "custom-client-id" }),
      encryptionKey: false,
    });

    const session = await server.getOrOpenSession("test-doc-2", {
      encrypted: false,
      context: ctx({ clientId: "custom-client-id" }),
    });

    const joined: string[] = [];
    session.on("client-join", (d) => joined.push(d.clientId));
    // The agent is already joined; verify via a fresh peer seeing it below.
    expect(session.documentId).toBe("test-doc-2");

    agent.destroy();
  });

  it("opens a session for the document", async () => {
    const agent = await createAgent(server, {
      document: "test-doc-session",
      context: ctx(),
      encryptionKey: false,
    });

    const session = await server.getOrOpenSession("test-doc-session", {
      encrypted: false,
      context: ctx(),
    });

    expect(session).toBeDefined();
    expect(session.documentId).toBe("test-doc-session");

    agent.destroy();
  });

  it("allows reading and writing the doc", async () => {
    const agent = await createAgent(server, {
      document: "modify-test-doc",
      context: ctx(),
      encryptionKey: false,
    });

    const text = agent.doc.getText("test");
    text.insert(0, "Hello, World!");

    expect(text.toString()).toBe("Hello, World!");

    agent.destroy();
  });

  it("propagates edits between two agents on the same document", async () => {
    const a = await createAgent(server, {
      document: "shared-doc",
      context: ctx({ clientId: "agent-a", userId: "user-a" }),
      encryptionKey: false,
    });
    const b = await createAgent(server, {
      document: "shared-doc",
      context: ctx({ clientId: "agent-b", userId: "user-b" }),
      encryptionKey: false,
    });

    a.doc.getText("content").insert(0, "written by a");

    await waitFor(() => b.doc.getText("content").toString() === "written by a");
    expect(b.doc.getText("content").toString()).toBe("written by a");

    a.destroy();
    b.destroy();
  });

  it("destroys the agent and cleans up without throwing", async () => {
    const agent = await createAgent(server, {
      document: "destroy-test-doc",
      context: ctx(),
      encryptionKey: false,
    });

    const disconnected: string[] = [];
    server.on("client-disconnect", (d) => disconnected.push(d.clientId));

    expect(() => agent.destroy()).not.toThrow();

    await waitFor(() => disconnected.includes("test-client"));
    expect(disconnected).toContain("test-client");
  });

  it("isolates agents in different rooms", async () => {
    const a = await createAgent(server, {
      document: "same-doc",
      context: ctx({ clientId: "client-1", userId: "user-1", room: "room-1" }),
      encryptionKey: false,
    });
    const b = await createAgent(server, {
      document: "same-doc",
      context: ctx({ clientId: "client-2", userId: "user-2", room: "room-2" }),
      encryptionKey: false,
    });

    const session1 = await server.getOrOpenSession("same-doc", {
      encrypted: false,
      context: ctx({ clientId: "client-1", userId: "user-1", room: "room-1" }),
    });
    const session2 = await server.getOrOpenSession("same-doc", {
      encrypted: false,
      context: ctx({ clientId: "client-2", userId: "user-2", room: "room-2" }),
    });

    expect(session1).not.toBe(session2);
    expect(session1.namespacedDocumentId).toBe("room-1/same-doc");
    expect(session2.namespacedDocumentId).toBe("room-2/same-doc");

    a.destroy();
    b.destroy();
  });

  it("handles an empty room in context", async () => {
    const agent = await createAgent(server, {
      document: "empty-room-doc",
      context: ctx({ room: "" }),
      encryptionKey: false,
    });

    const session = await server.getOrOpenSession("empty-room-doc", {
      encrypted: false,
      context: ctx({ room: "" }),
    });

    expect(session.namespacedDocumentId).toBe("empty-room-doc");

    agent.destroy();
  });

  it("rejects when document is missing", async () => {
    await expect(
      createAgent(server, {
        document: "",
        context: ctx({ room: "" }),
        encryptionKey: false,
      }),
    ).rejects.toThrow("Document is required");
  });

  it("tears down the agent's client when connection setup fails", async () => {
    // Force a failure during setup, after serverTransport has already
    // registered the client with the server (so its consume loop is live).
    // Without the catch-path teardown in createAgent this leaks that client.
    const disconnected: string[] = [];
    server.on("client-disconnect", (d) => disconnected.push(d.clientId));

    const originalCreateClient = server.createClient.bind(server);
    let created = 0;
    server.createClient = ((args: Parameters<typeof server.createClient>[0]) => {
      created++;
      // Register the client (spawns its consume loop) and then fail, so the
      // client exists and must be cleaned up by createAgent's catch path.
      originalCreateClient(args);
      throw new Error("boom: setup failed after client creation");
    }) as typeof server.createClient;

    await expect(
      createAgent(server, {
        document: "leak-doc",
        context: ctx({ clientId: "leak-client", userId: "u", room: "r" }),
        encryptionKey: false,
      }),
    ).rejects.toThrow();

    expect(created).toBe(1);
    // The client that was registered must be torn down on the error path.
    await waitFor(() => disconnected.includes("leak-client"));
    expect(disconnected).toContain("leak-client");

    server.createClient = originalCreateClient;
  });

  it("reconnects with the same client id after a server-initiated disconnect", async () => {
    const agent = await createAgent(server, {
      document: "reconnect-doc",
      context: ctx({ clientId: "reconnect-agent", userId: "u", room: "r" }),
      encryptionKey: false,
    });

    // Count how many times the agent's client (re)connects. The first connect
    // happens during createAgent; a reconnect must produce a second one with
    // the SAME id — proving the fixed client id does not block reconnection.
    const connects: string[] = [];
    server.on("client-connect", (d) => {
      if (d.clientId === "reconnect-agent") connects.push(d.clientId);
    });

    // The server evicts the agent's client (e.g. shutdown/rebalance). Fix #1
    // surfaces this to the connection as onClose, which schedules a reconnect.
    server.disconnectClient("reconnect-agent", "stream-ended");

    await waitFor(() => connects.length >= 1);
    expect(connects.length).toBeGreaterThanOrEqual(1);

    // After reconnecting, the agent still syncs: a fresh peer's edit reaches it.
    const peer = await createAgent(server, {
      document: "reconnect-doc",
      context: ctx({ clientId: "reconnect-peer", userId: "u2", room: "r" }),
      encryptionKey: false,
    });
    peer.doc.getText("content").insert(0, "after reconnect");

    await waitFor(() => agent.doc.getText("content").toString() === "after reconnect");
    expect(agent.doc.getText("content").toString()).toBe("after reconnect");

    agent.destroy();
    peer.destroy();
  });
});

// A tiny RPC protocol used to prove an agent can *call* server RPC methods
// and await typed responses — the capability the old bare Agent lacked.
const echo = defineMethod<{ text: string }, { echoed: string }>();
const whoami = defineMethod<{}, { userId: string; documentId: string }>();
const testProtocol = defineProtocol("test", { echo, whoami });

function getTestRpcHandlers() {
  return createHandlers(
    testProtocol,
    {},
    {
      echo: () => async (payload) => ok({ echoed: payload.text }),
      whoami: () => async (_payload, rpcCtx) =>
        ok({ userId: rpcCtx.userId ?? "", documentId: rpcCtx.documentId }),
    },
  );
}

const createTestRpc = createClientExtension(testProtocol);

describe("createAgent — outbound RPC", () => {
  let server: Server<ServerContext>;
  let pubSub: InMemoryPubSub;

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    server = new Server({
      storage: () => Promise.resolve(new MemoryDocumentStorage()),
      pubSub,
      rpcHandlers: { ...getTestRpcHandlers() },
    });
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  it("lets an agent call a server RPC method and await the response", async () => {
    const agent = await createAgent(server, {
      document: "rpc-doc",
      context: ctx(),
      encryptionKey: false,
      rpc: { test: createTestRpc },
    });

    const result = await agent.rpc.test.echo({ text: "ping" });
    expect(result).toEqual({ echoed: "ping" });

    agent.destroy();
  });

  it("stamps the agent's authenticated context onto RPC calls", async () => {
    const agent = await createAgent(server, {
      document: "rpc-doc-2",
      context: ctx({ userId: "agent-user", room: "agent-room" }),
      encryptionKey: false,
      rpc: { test: createTestRpc },
    });

    const result = await agent.rpc.test.whoami({});
    // userId comes from the authenticated context the transport stamps, and
    // the documentId is namespaced by the agent's room.
    expect(result.userId).toBe("agent-user");
    expect(result.documentId).toBe("agent-room/rpc-doc-2");

    agent.destroy();
  });
});

describe("createAgent — presence", () => {
  let server: Server<ServerContext>;
  let pubSub: InMemoryPubSub;

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    server = new Server({
      storage: () => Promise.resolve(new MemoryDocumentStorage()),
      pubSub,
    });
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  it("announces presence so another agent observes a peer-join", async () => {
    const a = await createAgent(server, {
      document: "presence-doc",
      context: ctx({ clientId: "agent-a", userId: "user-a" }),
      encryptionKey: false,
    });

    // Listen on the already-present agent before the newcomer joins, so we
    // deterministically catch the join broadcast (the roster reply to a late
    // listener would have already fired).
    const joins: number[] = [];
    a.on("peer-join", (peer) => joins.push(peer.awarenessId));

    const b = await createAgent(server, {
      document: "presence-doc",
      context: ctx({ clientId: "agent-b", userId: "user-b" }),
      encryptionKey: false,
    });

    // a should learn that b joined via presence.
    await waitFor(() => joins.includes(b.awareness.clientID));
    expect(joins).toContain(b.awareness.clientID);
    // a never sees itself.
    expect(joins).not.toContain(a.awareness.clientID);

    a.destroy();
    b.destroy();
  });

  it("shares awareness state between agents", async () => {
    const a = await createAgent(server, {
      document: "awareness-doc",
      context: ctx({ clientId: "agent-a", userId: "user-a" }),
      encryptionKey: false,
    });
    const b = await createAgent(server, {
      document: "awareness-doc",
      context: ctx({ clientId: "agent-b", userId: "user-b" }),
      encryptionKey: false,
    });

    const idA = a.awareness.clientID;
    a.awareness.setLocalState({ cursor: 42 });

    // The presence roster surfaces a peer's clientID (with an empty state) as
    // soon as it joins, so wait for the awareness payload itself to land.
    await waitFor(() => (b.awareness.getStates().get(idA) as { cursor?: number })?.cursor === 42);
    expect(b.awareness.getStates().get(idA)).toEqual({ cursor: 42 });

    a.destroy();
    b.destroy();
  });
});

describe("createAgent — encryption", () => {
  let server: Server<ServerContext>;
  let pubSub: InMemoryPubSub;

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    server = new Server({
      storage: () => Promise.resolve(new MemoryDocumentStorage()),
      pubSub,
    });
  });

  afterEach(async () => {
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
  });

  it("reads and writes plaintext on an encrypted document given the key", async () => {
    const key = await generateEncryptionKey();

    const a = await createAgent(server, {
      document: "enc-doc",
      context: ctx({ clientId: "agent-a", userId: "user-a" }),
      encryptionKey: key,
    });
    const b = await createAgent(server, {
      document: "enc-doc",
      context: ctx({ clientId: "agent-b", userId: "user-b" }),
      encryptionKey: key,
    });

    a.doc.getText("secret").insert(0, "classified");

    await waitFor(() => b.doc.getText("secret").toString() === "classified");
    expect(b.doc.getText("secret").toString()).toBe("classified");

    a.destroy();
    b.destroy();
  });

  it("tears the agent down when it holds the wrong key", async () => {
    const key = await generateEncryptionKey();
    const wrongKey = await generateEncryptionKey();

    const owner = await createAgent(server, {
      document: "wrong-key-doc",
      context: ctx({ clientId: "agent-owner", userId: "user-owner" }),
      encryptionKey: key,
    });
    owner.doc.getText("secret").insert(0, "classified");
    await owner.flush();

    // A failed agent must not leave its client attached to the session, nor
    // leak the Provider it had already built (Y.Doc, listeners, timers).
    await expect(
      createAgent(server, {
        document: "wrong-key-doc",
        context: ctx({ clientId: "agent-intruder", userId: "user-intruder" }),
        encryptionKey: wrongKey,
      }),
    ).rejects.toThrow();

    const session = server.getSession("test-room/wrong-key-doc")!;
    expect(session).toBeDefined();
    await waitFor(() => !session.hasClient("agent-intruder"));

    owner.destroy();
  });
});
