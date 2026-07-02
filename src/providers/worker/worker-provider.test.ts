import { describe, expect, it, afterEach } from "bun:test";
import * as Y from "yjs";
import { DirectConnection } from "../connection";
import { Provider } from "../provider";
import { createMemoryTransportPair } from "../transports/memory";
import { WorkerConnection } from "./worker-connection";
import { ConnectionWorkerManager } from "./connection-worker-manager";

function tick(ms = 1) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Creates a WorkerProvider-like setup using memory transports:
 *
 *   [client Provider] ── WorkerConnection ── MessagePort ── ConnectionWorkerManager
 *                                                               └── DirectConnection ── memoryTransport
 *                                                                                           │
 *   [server Provider] ── DirectConnection ── memoryTransport ─────────────────────────────────┘
 */
function createWorkerProviderTestRig(options?: { batchIntervalMs?: number }) {
  const [clientTransport, serverTransport] = createMemoryTransportPair();
  const batchIntervalMs = options?.batchIntervalMs ?? 0;

  // Worker side: manager holds the real DirectConnection
  const manager = new ConnectionWorkerManager(
    () => [clientTransport],
    { gracePeriodMs: 50 },
  );
  const channel = new MessageChannel();
  manager.addPort(channel.port1);

  // Client side: WorkerConnection proxies over MessagePort
  const workerConn = new WorkerConnection(channel.port2);
  workerConn.init({ connect: true, batchIntervalMs }, "tab-test");

  // Server side: direct connection + provider
  const serverConn = new DirectConnection({
    transports: [serverTransport],
    connect: false,
    batchIntervalMs,
  });

  return { workerConn, serverConn, manager, channel };
}

describe("WorkerProvider integration", () => {
  let cleanup: (() => void)[] = [];

  afterEach(async () => {
    for (const fn of cleanup) fn();
    cleanup = [];
    await tick();
  });

  it("syncs a Y.Doc between client (via WorkerConnection) and server", async () => {
    const { workerConn, serverConn, channel } = createWorkerProviderTestRig();

    // Client provider using WorkerConnection
    const clientDoc = new Y.Doc();
    const clientProvider = new Provider({
      connection: workerConn,
      document: "test-doc",
      encryptionKey: false,
      enableOfflinePersistence: false,
      ydoc: clientDoc,
    });

    // Server provider using DirectConnection
    const serverDoc = new Y.Doc();
    const serverProvider = new Provider({
      connection: serverConn,
      document: "test-doc",
      encryptionKey: false,
      enableOfflinePersistence: false,
      ydoc: serverDoc,
    });

    cleanup.push(() => {
      clientProvider.destroy({ destroyConnection: false });
      serverProvider.destroy({ destroyConnection: false });
      workerConn.destroy();
      serverConn.destroy();
      channel.port1.close();
    });

    // Connect both sides
    await serverConn.connect();
    await workerConn.connected;
    await tick();
    await tick();
    await tick();

    // Client writes to the doc
    clientDoc.getMap("data").set("greeting", "hello from worker");
    await tick();
    await tick();
    await tick();

    // Server should receive the update
    expect(serverDoc.getMap("data").get("greeting")).toBe("hello from worker");
  });

  it("syncs server changes back to client through WorkerConnection", async () => {
    const { workerConn, serverConn, channel } = createWorkerProviderTestRig();

    const clientDoc = new Y.Doc();
    const clientProvider = new Provider({
      connection: workerConn,
      document: "test-doc",
      encryptionKey: false,
      enableOfflinePersistence: false,
      ydoc: clientDoc,
    });

    const serverDoc = new Y.Doc();
    const serverProvider = new Provider({
      connection: serverConn,
      document: "test-doc",
      encryptionKey: false,
      enableOfflinePersistence: false,
      ydoc: serverDoc,
    });

    cleanup.push(() => {
      clientProvider.destroy({ destroyConnection: false });
      serverProvider.destroy({ destroyConnection: false });
      workerConn.destroy();
      serverConn.destroy();
      channel.port1.close();
    });

    await serverConn.connect();
    await workerConn.connected;
    await tick();
    await tick();
    await tick();

    // Server writes to the doc
    serverDoc.getMap("data").set("response", "hello from server");
    await tick();
    await tick();
    await tick();

    // Client should receive the update through the worker proxy
    expect(clientDoc.getMap("data").get("response")).toBe("hello from server");
  });

  it("multiple providers on same WorkerConnection share one socket", async () => {
    const { workerConn, serverConn, manager, channel } = createWorkerProviderTestRig();

    const docA = new Y.Doc();
    const providerA = new Provider({
      connection: workerConn,
      document: "doc-a",
      encryptionKey: false,
      enableOfflinePersistence: false,
      ydoc: docA,
    });

    const docB = new Y.Doc();
    const providerB = new Provider({
      connection: workerConn,
      document: "doc-b",
      encryptionKey: false,
      enableOfflinePersistence: false,
      ydoc: docB,
    });

    cleanup.push(() => {
      providerA.destroy({ destroyConnection: false });
      providerB.destroy({ destroyConnection: false });
      workerConn.destroy();
      serverConn.destroy();
      channel.port1.close();
    });

    await serverConn.connect();
    await workerConn.connected;
    await tick();
    await tick();
    await tick();

    // Both providers share one underlying connection
    expect(manager.connectionCount).toBe(1);

    docA.getMap("data").set("from", "doc-a");
    docB.getMap("data").set("from", "doc-b");
    await tick();
    await tick();
    await tick();

    // Both docs should have written independently
    expect(docA.getMap("data").get("from")).toBe("doc-a");
    expect(docB.getMap("data").get("from")).toBe("doc-b");
  });

  it("two tabs share one connection and both receive server updates", async () => {
    const [clientTransport, serverTransport] = createMemoryTransportPair();
    const manager = new ConnectionWorkerManager(() => [clientTransport], { gracePeriodMs: 50 });

    // Tab A
    const channelA = new MessageChannel();
    manager.addPort(channelA.port1);
    const connA = new WorkerConnection(channelA.port2);
    connA.init({ url: "wss://test.com", connect: true, batchIntervalMs: 0 }, "tab-A");

    const docA = new Y.Doc();
    const providerA = new Provider({
      connection: connA,
      document: "shared-doc",
      encryptionKey: false,
      enableOfflinePersistence: false,
      ydoc: docA,
    });

    // Tab B
    const channelB = new MessageChannel();
    manager.addPort(channelB.port1);
    const connB = new WorkerConnection(channelB.port2);
    connB.init({ url: "wss://test.com", connect: true, batchIntervalMs: 0 }, "tab-B");

    const docB = new Y.Doc();
    const providerB = new Provider({
      connection: connB,
      document: "shared-doc",
      encryptionKey: false,
      enableOfflinePersistence: false,
      ydoc: docB,
    });

    // Server
    const serverConn = new DirectConnection({
      transports: [serverTransport],
      connect: false,
      batchIntervalMs: 0,
    });
    const serverDoc = new Y.Doc();
    const serverProvider = new Provider({
      connection: serverConn,
      document: "shared-doc",
      encryptionKey: false,
      enableOfflinePersistence: false,
      ydoc: serverDoc,
    });

    cleanup.push(() => {
      providerA.destroy({ destroyConnection: false });
      providerB.destroy({ destroyConnection: false });
      serverProvider.destroy({ destroyConnection: false });
      connA.destroy();
      connB.destroy();
      serverConn.destroy();
      channelA.port1.close();
      channelB.port1.close();
    });

    await serverConn.connect();
    await connA.connected;
    await connB.connected;
    await tick();
    await tick();
    await tick();

    // One underlying connection for both tabs
    expect(manager.connectionCount).toBe(1);

    // Server writes
    serverDoc.getMap("data").set("broadcast", "to all tabs");
    await tick();
    await tick();
    await tick();

    // Both tabs receive the update
    expect(docA.getMap("data").get("broadcast")).toBe("to all tabs");
    expect(docB.getMap("data").get("broadcast")).toBe("to all tabs");

    // Tab A writes — should reach server
    docA.getMap("data").set("from-a", "hello");
    await tick();
    await tick();
    await tick();

    expect(serverDoc.getMap("data").get("from-a")).toBe("hello");
  });
});
