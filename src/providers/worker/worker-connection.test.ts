import { describe, expect, it, afterEach } from "bun:test";
import * as Y from "yjs";
import { DocMessage } from "teleportal";
import { encodeContentEncryptedPayload } from "teleportal/protocol/encryption";
import type { VersionedUpdate } from "teleportal/protocol";
import { DirectConnection as Connection } from "../connection";
import { createMemoryTransportPair } from "../transports/memory";
import { WorkerConnection } from "./worker-connection";
import { ConnectionWorkerManager } from "./connection-worker-manager";

function makeDocUpdate(docName: string, text = "hello"): DocMessage<any> {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, text);
  const payload = encodeContentEncryptedPayload({
    structureUpdate: Y.encodeStateAsUpdateV2(doc),
    encryptedSidecars: [],
  });
  return new DocMessage(
    docName,
    { type: "update", update: { version: 2, data: payload } as unknown as VersionedUpdate },
    {},
    false,
  );
}

function tick(ms = 1) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

const SHORT_GRACE_MS = 5;

function setup() {
  const [clientTransport, serverTransport] = createMemoryTransportPair();
  const manager = new ConnectionWorkerManager(() => [clientTransport], {
    gracePeriodMs: SHORT_GRACE_MS,
  });
  const channel = new MessageChannel();
  manager.addPort(channel.port1);
  const workerConn = new WorkerConnection(channel.port2);
  return { clientTransport, serverTransport, manager, workerConn, channel };
}

async function initAndConnect(workerConn: WorkerConnection, options: Record<string, unknown> = {}) {
  workerConn.init({ connect: true, ...options }, "tab-" + Math.random().toString(36).slice(2, 6));
  await tick();
  await tick();
  await tick();
}

describe("WorkerConnection", () => {
  let cleanup: (() => void)[] = [];
  afterEach(async () => {
    for (const fn of cleanup) fn();
    cleanup = [];
    await tick();
  });

  it("connects through the proxy and mirrors state", async () => {
    const { workerConn, channel } = setup();
    cleanup.push(() => {
      workerConn.destroy();
      channel.port1.close();
    });

    await initAndConnect(workerConn);

    expect(workerConn.state.type).toBe("connected");
  });

  it("fires connected/disconnected/update exactly once per transition", async () => {
    const { workerConn, channel } = setup();
    cleanup.push(() => {
      workerConn.destroy();
      channel.port1.close();
    });

    let connectedCount = 0;
    let disconnectedCount = 0;
    let connectedUpdateCount = 0;
    workerConn.on("connected", () => connectedCount++);
    workerConn.on("disconnected", () => disconnectedCount++);
    workerConn.on("update", (state) => {
      if (state.type === "connected") connectedUpdateCount++;
    });

    await initAndConnect(workerConn);
    expect(workerConn.state.type).toBe("connected");
    expect(connectedCount).toBe(1);
    expect(connectedUpdateCount).toBe(1);

    await workerConn.disconnect();
    await tick();
    await tick();

    expect(workerConn.state.type).toBe("disconnected");
    expect(disconnectedCount).toBe(1);
  });

  it("sends messages from WorkerConnection to the server transport", async () => {
    const { workerConn, clientTransport, channel } = setup();
    cleanup.push(() => {
      workerConn.destroy();
      channel.port1.close();
    });

    await initAndConnect(workerConn, { batchIntervalMs: 0 });

    const msg = makeDocUpdate("test-doc", "world");
    await workerConn.send(msg);
    await tick();
    await tick();

    expect(clientTransport.sentMessages.length).toBeGreaterThanOrEqual(1);
    const sent = clientTransport.sentMessages.find((m) => m.type === "doc");
    expect(sent).toBeDefined();
    expect(sent!.document).toBe("test-doc");
  });

  it("receives messages from server and fans out to WorkerConnection", async () => {
    const [clientTransport, serverTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });
    const channel = new MessageChannel();
    manager.addPort(channel.port1);
    const workerConn = new WorkerConnection(channel.port2);

    const serverConn = new Connection({
      transports: [serverTransport],
      connect: false,
      batchIntervalMs: 0,
    });

    cleanup.push(() => {
      workerConn.destroy();
      serverConn.destroy();
      channel.port1.close();
    });

    await initAndConnect(workerConn);
    await serverConn.connect();
    await tick();

    const reader = workerConn.getReader();
    const receivedMessages: any[] = [];
    void (async () => {
      for await (const batch of reader.source) {
        for (const msg of batch) receivedMessages.push(msg);
      }
    })();

    const serverMsg = makeDocUpdate("test-doc", "from-server");
    await serverConn.send(serverMsg);
    await tick();
    await tick();
    await tick();

    expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
    reader.unsubscribe();
  });

  it("supports multi-tab: two WorkerConnections share one real Connection", async () => {
    const [clientTransport, serverTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });

    const channelA = new MessageChannel();
    const channelB = new MessageChannel();
    manager.addPort(channelA.port1);
    manager.addPort(channelB.port1);

    const connA = new WorkerConnection(channelA.port2);
    const connB = new WorkerConnection(channelB.port2);

    const serverConn = new Connection({
      transports: [serverTransport],
      connect: false,
      batchIntervalMs: 0,
    });

    cleanup.push(() => {
      connA.destroy();
      connB.destroy();
      serverConn.destroy();
      channelA.port1.close();
      channelB.port1.close();
    });

    connA.init({ url: "wss://example.com", connect: true }, "tab-A");
    connB.init({ url: "wss://example.com", connect: true }, "tab-B");

    await tick();
    await tick();
    await tick();

    await serverConn.connect();
    await tick();

    expect(manager.connectionCount).toBe(1);
    expect(connA.state.type).toBe("connected");
    expect(connB.state.type).toBe("connected");

    const readerA = connA.getReader();
    const readerB = connB.getReader();
    const msgsA: any[] = [];
    const msgsB: any[] = [];
    void (async () => {
      for await (const batch of readerA.source) msgsA.push(...batch);
    })();
    void (async () => {
      for await (const batch of readerB.source) msgsB.push(...batch);
    })();

    const serverMsg = makeDocUpdate("shared-doc", "broadcast");
    await serverConn.send(serverMsg);
    await tick();
    await tick();
    await tick();

    expect(msgsA.length).toBeGreaterThanOrEqual(1);
    expect(msgsB.length).toBeGreaterThanOrEqual(1);

    readerA.unsubscribe();
    readerB.unsubscribe();
  });

  it("does NOT share across tabs with different tokens (multi-author isolation)", async () => {
    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });

    const channelA = new MessageChannel();
    const channelB = new MessageChannel();
    manager.addPort(channelA.port1);
    manager.addPort(channelB.port1);

    const connA = new WorkerConnection(channelA.port2);
    const connB = new WorkerConnection(channelB.port2);

    cleanup.push(() => {
      connA.destroy();
      connB.destroy();
      channelA.port1.close();
      channelB.port1.close();
    });

    // Same origin, but two different authors (distinct tokens). Since identity/
    // attribution is derived from the token, they must NOT share a connection.
    // The default key is URL + token, so each author gets its own connection —
    // achieved without the manager parsing the token.
    connA.init({ url: "wss://example.com/", token: "token-author-a", connect: true }, "tab-A");
    connB.init({ url: "wss://example.com/", token: "token-author-b", connect: true }, "tab-B");

    await tick();
    await tick();
    await tick();

    expect(manager.connectionCount).toBe(2);
    expect(connA.state.type).toBe("connected");
    expect(connB.state.type).toBe("connected");
  });

  it("shares across tabs with the same URL + token (same author)", async () => {
    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });

    const channelA = new MessageChannel();
    const channelB = new MessageChannel();
    manager.addPort(channelA.port1);
    manager.addPort(channelB.port1);

    const connA = new WorkerConnection(channelA.port2);
    const connB = new WorkerConnection(channelB.port2);

    cleanup.push(() => {
      connA.destroy();
      connB.destroy();
      channelA.port1.close();
      channelB.port1.close();
    });

    connA.init({ url: "wss://example.com/", token: "token-author-a", connect: true }, "tab-A");
    connB.init({ url: "wss://example.com/", token: "token-author-a", connect: true }, "tab-B");

    await tick();
    await tick();
    await tick();

    expect(manager.connectionCount).toBe(1);
    expect(connA.state.type).toBe("connected");
    expect(connB.state.type).toBe("connected");
  });

  it("a custom getConnectionKey can widen sharing across token refreshes", async () => {
    const [clientTransport] = createMemoryTransportPair();
    // Key on a stable per-user id the caller derives however it likes; the
    // manager stays agnostic to the token format. Here two rotated tokens for the
    // same user collapse to one connection.
    const userForToken: Record<string, string> = {
      "token-v1": "user-1",
      "token-v2": "user-1",
    };
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
      getConnectionKey: (o) => `${o.url}::${userForToken[o.token ?? ""] ?? o.token}`,
    });

    const channelA = new MessageChannel();
    const channelB = new MessageChannel();
    manager.addPort(channelA.port1);
    manager.addPort(channelB.port1);

    const connA = new WorkerConnection(channelA.port2);
    const connB = new WorkerConnection(channelB.port2);

    cleanup.push(() => {
      connA.destroy();
      connB.destroy();
      channelA.port1.close();
      channelB.port1.close();
    });

    connA.init({ url: "wss://example.com/", token: "token-v1", connect: true }, "tab-A");
    connB.init({ url: "wss://example.com/", token: "token-v2", connect: true }, "tab-B");

    await tick();
    await tick();
    await tick();

    // Different tokens, same resolved user -> one shared connection.
    expect(manager.connectionCount).toBe(1);
  });

  it("tab disconnect preserves Connection for remaining tabs", async () => {
    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });

    const channelA = new MessageChannel();
    const channelB = new MessageChannel();
    manager.addPort(channelA.port1);
    manager.addPort(channelB.port1);

    const connA = new WorkerConnection(channelA.port2);
    const connB = new WorkerConnection(channelB.port2);

    cleanup.push(() => {
      connB.destroy();
      channelA.port1.close();
      channelB.port1.close();
    });

    connA.init({ url: "wss://test.com", connect: true }, "tab-A");
    connB.init({ url: "wss://test.com", connect: true }, "tab-B");

    await tick();
    await tick();
    await tick();

    expect(manager.connectionCount).toBe(1);

    await connA.destroy();
    await tick();

    // Connection survives during grace period
    expect(manager.connectionCount).toBe(1);
    expect(connB.state.type).toBe("connected");
  });

  it("grace period: Connection kept alive briefly after last tab disconnects", async () => {
    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });

    const channel = new MessageChannel();
    manager.addPort(channel.port1);
    const conn = new WorkerConnection(channel.port2);

    conn.init({ url: "wss://grace.com", connect: true }, "tab-A");
    await tick();
    await tick();
    await tick();

    expect(manager.connectionCount).toBe(1);

    await conn.destroy();
    await tick();

    // Still alive during grace period
    expect(manager.connectionCount).toBe(1);

    // A new tab connecting during grace period reuses the Connection
    const channel2 = new MessageChannel();
    manager.addPort(channel2.port1);
    const conn2 = new WorkerConnection(channel2.port2);
    cleanup.push(() => {
      conn2.destroy();
      channel2.port1.close();
    });

    conn2.init({ url: "wss://grace.com", connect: true }, "tab-B");
    await tick();
    await tick();

    expect(manager.connectionCount).toBe(1);
    expect(conn2.state.type).toBe("connected");
  });

  it("cleans up Connection after grace period when all tabs gone", async () => {
    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });

    const channel = new MessageChannel();
    manager.addPort(channel.port1);
    const conn = new WorkerConnection(channel.port2);

    conn.init({ url: "wss://cleanup.com", connect: true }, "tab-A");
    await tick();
    await tick();
    await tick();

    expect(manager.connectionCount).toBe(1);

    await conn.destroy();

    // Wait for grace period to expire
    await new Promise<void>((r) => setTimeout(r, SHORT_GRACE_MS + 5));

    expect(manager.connectionCount).toBe(0);
  });

  it("WorkerConnection.connected resolves when real connection connects", async () => {
    const { workerConn, channel } = setup();
    cleanup.push(() => {
      workerConn.destroy();
      channel.port1.close();
    });

    workerConn.init({ connect: true }, "tab-1");

    await workerConn.connected;
    expect(workerConn.state.type).toBe("connected");
  });

  it("token is propagated through to the underlying DirectConnection", async () => {
    const [clientTransport] = createMemoryTransportPair();
    let capturedOptions: Record<string, unknown> | undefined;
    const manager = new ConnectionWorkerManager(
      (options) => {
        capturedOptions = options as Record<string, unknown>;
        return [clientTransport];
      },
      { gracePeriodMs: SHORT_GRACE_MS },
    );
    const channel = new MessageChannel();
    manager.addPort(channel.port1);
    const workerConn = new WorkerConnection(channel.port2);

    cleanup.push(() => {
      workerConn.destroy();
      channel.port1.close();
    });

    workerConn.init({ url: "wss://example.com/", token: "my-jwt", connect: true }, "tab-1");

    await workerConn.connected;
    expect(workerConn.state.type).toBe("connected");
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.token).toBe("my-jwt");
  });

  it("heartbeat detects worker death", async () => {
    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });
    const channel = new MessageChannel();
    manager.addPort(channel.port1);

    let workerDied = false;
    const workerConn = new WorkerConnection(channel.port2, {
      onWorkerDeath: () => {
        workerDied = true;
      },
    });

    cleanup.push(() => workerConn.destroy());

    await initAndConnect(workerConn);

    workerConn.startHeartbeat(5, 2);

    // Kill the worker-side port (simulates worker crash)
    channel.port1.close();

    // Poll until the heartbeat detects the death
    for (let i = 0; i < 50 && !workerDied; i++) {
      await new Promise<void>((r) => setTimeout(r, 1));
    }

    expect(workerDied).toBe(true);
  });

  it("online/offline reconciliation: any-tab-online policy", async () => {
    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });

    const channelA = new MessageChannel();
    const channelB = new MessageChannel();
    manager.addPort(channelA.port1);
    manager.addPort(channelB.port1);

    const connA = new WorkerConnection(channelA.port2);
    const connB = new WorkerConnection(channelB.port2);

    cleanup.push(() => {
      connA.destroy();
      connB.destroy();
      channelA.port1.close();
      channelB.port1.close();
    });

    connA.init({ url: "wss://online-test.com", connect: true }, "tab-A");
    connB.init({ url: "wss://online-test.com", connect: true }, "tab-B");
    await tick();
    await tick();
    await tick();

    // Tab A goes offline via WorkerConnection API, Tab B stays online
    connA.forwardNetworkStatus(false);
    await tick();

    // Connection stays alive thanks to any-tab-online policy
    expect(manager.connectionCount).toBe(1);
  });

  it("sent-message events carry reconstructable Message objects", async () => {
    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });
    const channel = new MessageChannel();
    manager.addPort(channel.port1);
    const workerConn = new WorkerConnection(channel.port2);

    cleanup.push(() => {
      workerConn.destroy();
      channel.port1.close();
    });

    await initAndConnect(workerConn, { batchIntervalMs: 0 });

    const sentMessages: any[] = [];
    workerConn.on("sent-message", (msg) => {
      sentMessages.push(msg);
    });

    const msg = makeDocUpdate("test-doc", "check-event");
    await workerConn.send(msg);
    await tick();
    await tick();
    await tick();

    // The sent-message event should carry a proper Message with .encoded
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const sentMsg = sentMessages.find((m) => m.document === "test-doc");
    expect(sentMsg).toBeDefined();
    expect(sentMsg.encoded).toBeInstanceOf(Uint8Array);
  });

  it("sends presence-unannounce for tracked awarenessIds when port is destroyed", async () => {
    const { PresenceMessage } = await import("teleportal");

    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });
    const channel = new MessageChannel();
    manager.addPort(channel.port1);
    const workerConn = new WorkerConnection(channel.port2);

    await initAndConnect(workerConn);

    // key is "default::" because init has no url/token
    const directConn = manager.getConnection("default::");
    expect(directConn).toBeDefined();

    const sentMessages: any[] = [];
    const unsub = directConn!.on("sent-message", (msg: any) => {
      sentMessages.push(msg);
    });

    // Send a presence-announce through the worker
    const announce = new PresenceMessage("test-doc", {
      type: "presence-announce",
      awarenessId: 42,
    });
    await workerConn.send(announce);
    await tick();
    await tick();

    // Clear recorded messages before destroy
    sentMessages.length = 0;

    // Destroy the port — should trigger presence-unannounce
    await workerConn.destroy();
    await tick();
    await tick();
    await tick();

    unsub();

    const unannounces = sentMessages.filter(
      (m) => m.type === "presence" && m.payload?.type === "presence-unannounce",
    );
    expect(unannounces).toHaveLength(1);
    expect(unannounces[0].payload.awarenessId).toBe(42);
  });

  it("releases the port and unannounces presence on the port close event", async () => {
    const { PresenceMessage } = await import("teleportal");

    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });
    const channel = new MessageChannel();
    manager.addPort(channel.port1);
    const workerConn = new WorkerConnection(channel.port2);

    await initAndConnect(workerConn);

    const directConn = manager.getConnection("default::");
    const sentMessages: any[] = [];
    const unsub = directConn!.on("sent-message", (msg: any) => {
      sentMessages.push(msg);
    });

    await workerConn.send(
      new PresenceMessage("test-doc", { type: "presence-announce", awarenessId: 7 }),
    );
    await tick();
    await tick();
    sentMessages.length = 0;

    // Simulate the tab dying without a destroy message (refresh/crash): the
    // browser fires `close` on the worker-side port.
    channel.port1.dispatchEvent(new Event("close"));
    await tick();

    unsub();

    const unannounces = sentMessages.filter(
      (m) => m.type === "presence" && m.payload?.type === "presence-unannounce",
    );
    expect(unannounces).toHaveLength(1);
    expect(unannounces[0].payload.awarenessId).toBe(7);

    // With its last port gone, the connection is destroyed after the grace period.
    await tick(SHORT_GRACE_MS * 3);
    expect(manager.connectionCount).toBe(0);
  });

  it("close event after an explicit destroy does not unannounce twice", async () => {
    const { PresenceMessage } = await import("teleportal");

    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });
    const channel = new MessageChannel();
    manager.addPort(channel.port1);
    const workerConn = new WorkerConnection(channel.port2);

    await initAndConnect(workerConn);

    const directConn = manager.getConnection("default::");
    const sentMessages: any[] = [];
    const unsub = directConn!.on("sent-message", (msg: any) => {
      sentMessages.push(msg);
    });

    await workerConn.send(
      new PresenceMessage("test-doc", { type: "presence-announce", awarenessId: 9 }),
    );
    await tick();
    await tick();
    sentMessages.length = 0;

    await workerConn.destroy();
    await tick();
    channel.port1.dispatchEvent(new Event("close"));
    await tick();

    unsub();

    const unannounces = sentMessages.filter(
      (m) => m.type === "presence" && m.payload?.type === "presence-unannounce",
    );
    expect(unannounces).toHaveLength(1);
  });

  it("relays updates and awareness to sibling tabs, but not to the sender or for sync steps", async () => {
    const { AwarenessMessage, DocMessage } = await import("teleportal");

    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
    });
    const chA = new MessageChannel();
    manager.addPort(chA.port1);
    const connA = new WorkerConnection(chA.port2);
    const chB = new MessageChannel();
    manager.addPort(chB.port1);
    const connB = new WorkerConnection(chB.port2);
    await initAndConnect(connA);
    await initAndConnect(connB);

    const aReceived: any[] = [];
    connA.on("received-message", (m: any) => aReceived.push(m));
    const bReceived: any[] = [];
    connB.on("received-message", (m: any) => bReceived.push(m));

    // A doc update from tab A reaches sibling tab B locally — the server
    // never echoes it back to the shared connection.
    await connA.send(makeDocUpdate("doc-1"));
    // Awareness updates relay the same way.
    await connA.send(
      new AwarenessMessage(
        "doc-1",
        { type: "awareness-update", update: new Uint8Array([1]) as any },
        {},
      ),
    );
    // Sync handshake messages are server-directed and must NOT be relayed —
    // a sibling would answer them and cross-talk the handshake.
    await connA.send(new DocMessage("doc-1", { type: "sync-done" }, {}, false));
    await tick();
    await tick();

    const bDocUpdates = bReceived.filter((m) => m.type === "doc" && m.payload?.type === "update");
    const bAwareness = bReceived.filter((m) => m.type === "awareness");
    const bSync = bReceived.filter((m) => m.type === "doc" && m.payload?.type === "sync-done");
    expect(bDocUpdates).toHaveLength(1);
    expect(bAwareness).toHaveLength(1);
    expect(bSync).toHaveLength(0);
    // The sender must not receive its own messages back.
    expect(aReceived).toHaveLength(0);

    await connA.destroy();
    await connB.destroy();
    await tick(SHORT_GRACE_MS * 3);
  });

  it("destroys the connection on pagehide unless the page enters the bfcache", async () => {
    const { workerConn } = setup();
    await initAndConnect(workerConn);
    workerConn.listenForPageHide();

    // Entering the back/forward cache: the page may come back, keep the connection.
    const persisted = new Event("pagehide");
    Object.defineProperty(persisted, "persisted", { value: true });
    globalThis.dispatchEvent(persisted);
    await tick();
    expect(workerConn.destroyed).toBe(false);

    // Real discard (refresh/close): destroy so the worker releases the port.
    globalThis.dispatchEvent(new Event("pagehide"));
    await tick();
    expect(workerConn.destroyed).toBe(true);
  });

  it("sweeps a port whose heartbeats stopped, but never a port that has not heartbeated", async () => {
    const { PresenceMessage } = await import("teleportal");

    const [clientTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], {
      gracePeriodMs: SHORT_GRACE_MS,
      stalePortCheckMs: 2,
      stalePortThresholdMs: 5,
    });

    // Port A heartbeats once, then goes silent. Port B never heartbeats.
    const channelA = new MessageChannel();
    manager.addPort(channelA.port1);
    const connA = new WorkerConnection(channelA.port2);
    const channelB = new MessageChannel();
    manager.addPort(channelB.port1);
    const connB = new WorkerConnection(channelB.port2);

    await initAndConnect(connA);
    await initAndConnect(connB);

    const directConn = manager.getConnection("default::");
    const sentMessages: any[] = [];
    const unsub = directConn!.on("sent-message", (msg: any) => {
      sentMessages.push(msg);
    });

    await connA.send(new PresenceMessage("doc-a", { type: "presence-announce", awarenessId: 1 }));
    await connB.send(new PresenceMessage("doc-b", { type: "presence-announce", awarenessId: 2 }));
    // A single heartbeat from A makes it sweep-eligible once it goes silent.
    (channelA.port2 as MessagePort).postMessage({ type: "heartbeat" });
    await tick();
    await tick();
    sentMessages.length = 0;

    // Wait past the stale threshold so the sweep fires.
    await tick(20);

    unsub();

    const unannounces = sentMessages.filter(
      (m) => m.type === "presence" && m.payload?.type === "presence-unannounce",
    );
    // Only port A's presence is retracted; the never-heartbeating port B is
    // left alone (it may be a custom WorkerConnection without startHeartbeat).
    expect(unannounces).toHaveLength(1);
    expect(unannounces[0].payload.awarenessId).toBe(1);
    // The connection survives because port B is still attached.
    expect(manager.connectionCount).toBe(1);

    await connB.destroy();
    await tick(SHORT_GRACE_MS * 3);
  });

  describe("heartbeat liveness", () => {
    async function until(cond: () => boolean, timeoutMs = 500) {
      const start = Date.now();
      while (!cond()) {
        if (Date.now() - start > timeoutMs) {
          throw new Error("condition not met in time");
        }
        await tick(1);
      }
    }

    it("treats any downstream worker message as proof of liveness", async () => {
      // Raw channel with no manager: heartbeats are never acked, but the
      // "worker" keeps sending other traffic — as happens when heartbeat-acks
      // queue behind bulk data (e.g. 1MB file-download parts) on a congested
      // main thread. The worker is alive; the connection must not error.
      const channel = new MessageChannel();
      const conn = new WorkerConnection(channel.port2);
      cleanup.push(() => {
        conn.destroy();
        channel.port1.close();
      });

      let errored = false;
      conn.on("update", (state) => {
        if (state.type === "errored") errored = true;
      });

      conn.startHeartbeat(3, 2);
      for (let i = 0; i < 25; i++) {
        channel.port1.postMessage({ type: "event", event: "ping", args: [] });
        await tick(1);
      }

      expect(errored).toBe(false);
    });

    it("recovers and restarts the heartbeat when the worker resumes", async () => {
      const channel = new MessageChannel();
      const conn = new WorkerConnection(channel.port2);
      cleanup.push(() => {
        conn.destroy();
        channel.port1.close();
      });

      channel.port1.postMessage({
        type: "state-update",
        state: { type: "connected", transport: "memory" },
      });
      await until(() => conn.state.type === "connected");

      // Total silence from the worker → presumed dead.
      conn.startHeartbeat(1, 2);
      await until(() => conn.state.type === "errored");

      // The worker resumes sending: the connection must revive to its prior
      // state instead of staying bricked until a page reload.
      channel.port1.postMessage({ type: "event", event: "ping", args: [] });
      await until(() => conn.state.type === "connected");

      // And the heartbeat must be running again: renewed silence re-errors.
      await until(() => conn.state.type === "errored");
    });
  });
});
