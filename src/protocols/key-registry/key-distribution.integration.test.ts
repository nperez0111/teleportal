import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import crossws from "crossws/adapters/bun";
import * as Y from "yjs";
import { deriveWrappingKey, importWrappingKey, registryKey } from "teleportal/encryption-key";
import { InMemoryPubSub, type ServerContext } from "teleportal";
import { MemoryDocumentStorage } from "teleportal/storage";
import { InMemoryKeyRegistryStorage } from "../../storage/in-memory/key-registry-storage";
import { getKeyRegistryRpcHandlers } from "./server";
import { getKeyRegistryHandlers } from "./http";
import { Server } from "../../server/server";
import { getWebsocketHandlers } from "../../websocket-server";
import { DirectConnection as Connection } from "../../providers/connection";
import { websocketTransport } from "../../providers/transports/websocket";
import { Provider } from "../../providers/provider";

type Ctx = ServerContext;

const MASTER_SECRET = crypto.getRandomValues(new Uint8Array(32));

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

describe("key-registry distribution: two encrypted clients via WebSocket", () => {
  let pubSub: InMemoryPubSub;
  let server: Server<Ctx>;
  let keyRegistryStorage: InMemoryKeyRegistryStorage;
  let keyHandler: ReturnType<typeof getKeyRegistryHandlers>;
  let bunServer: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  const cleanups: Array<() => void | Promise<void>> = [];

  // Track userId per-connection so onUpgrade can assign distinct identities.
  let nextUserId: string;

  beforeEach(async () => {
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    pubSub = new InMemoryPubSub();
    keyRegistryStorage = new InMemoryKeyRegistryStorage();

    keyHandler = getKeyRegistryHandlers({
      storage: keyRegistryStorage,
      masterSecret: MASTER_SECRET,
    });

    server = new Server<Ctx>({
      storage: async () => new MemoryDocumentStorage(true),
      pubSub,
      rpcHandlers: getKeyRegistryRpcHandlers(keyRegistryStorage),
    });

    nextUserId = "alice";

    const ws = crossws({
      hooks: getWebsocketHandlers<Ctx>({
        server,
        onUpgrade: async () => ({
          context: { userId: nextUserId, room: "test" },
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
    bunServer.stop(true);
    await server[Symbol.asyncDispose]();
    await pubSub[Symbol.asyncDispose]();
    await new Promise((r) => setTimeout(r, 0));
    for (const cleanup of cleanups.splice(0)) {
      try {
        await cleanup();
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 0));
  });

  function req(method: string, path: string, body?: Record<string, unknown>): Request {
    return new Request(`http://localhost${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function createProviderWithRegistryKey(
    document: string,
    userId: string,
    wrappingKeyString: string,
  ) {
    nextUserId = userId;
    const wrappingKey = await importWrappingKey(wrappingKeyString);

    const conn = new Connection({
      url: baseUrl,
      transports: [websocketTransport()],
      connect: true,
      maxReconnectAttempts: 0,
      batchIntervalMs: 0,
    });
    cleanups.push(() => conn.destroy());

    const provider = await Provider.create({
      connection: conn,
      document,
      encryptionKey: registryKey({ wrappingKey }),
      enableOfflinePersistence: false,
    });
    cleanups.push(() => {
      provider.transport.synced?.catch(() => {});
      provider.destroy();
    });

    return { provider, connection: conn };
  }

  it("alice mints a key, grants bob, both sync encrypted content", async () => {
    const docId = "shared-doc";
    const room = "test";

    // Alice mints a new document key via the HTTP key-management API.
    // The `room` field mirrors the server's namespace so the RPC lookup matches.
    const mintRes = await (
      await keyHandler(req("POST", `/keys/${docId}/mint`, { userId: "alice", room }))
    ).json();
    const aliceWrappingKey: string = mintRes.wrappingKey;

    // Grant bob access — the server unwraps Alice's key and re-wraps for Bob.
    const grantRes = await (
      await keyHandler(req("POST", `/keys/${docId}/grant`, { userId: "bob", room }))
    ).json();
    const bobWrappingKey: string = grantRes.wrappingKey;

    // Alice connects with her registry-resolved key.
    const { provider: pA } = await createProviderWithRegistryKey(docId, "alice", aliceWrappingKey);
    await waitForSync(pA);

    // Alice writes encrypted content.
    pA.doc.getText("body").insert(0, "hello from alice");
    await new Promise((r) => setTimeout(r, 1));

    // Bob connects with his own registry-resolved key.
    const { provider: pB } = await createProviderWithRegistryKey(docId, "bob", bobWrappingKey);
    await waitForSync(pB);

    // Bob receives Alice's encrypted content.
    const text = await waitForContent(pB.doc, "body", (t) => t === "hello from alice");
    expect(text).toBe("hello from alice");
  });

  it("bidirectional sync: both registry-keyed clients exchange live updates", async () => {
    const docId = "bidi-doc";
    const room = "test";

    const mintRes = await (
      await keyHandler(req("POST", `/keys/${docId}/mint`, { userId: "alice", room }))
    ).json();
    const grantRes = await (
      await keyHandler(req("POST", `/keys/${docId}/grant`, { userId: "bob", room }))
    ).json();

    const { provider: pA } = await createProviderWithRegistryKey(
      docId,
      "alice",
      mintRes.wrappingKey,
    );
    await waitForSync(pA);

    pA.doc.getText("body").insert(0, "hello");
    await new Promise((r) => setTimeout(r, 1));

    const { provider: pB } = await createProviderWithRegistryKey(
      docId,
      "bob",
      grantRes.wrappingKey,
    );
    await waitForSync(pB);
    await waitForContent(pB.doc, "body", (t) => t === "hello");

    // Bob appends.
    pB.doc.getText("body").insert(5, " world");
    const textA = await waitForContent(pA.doc, "body", (t) => t === "hello world");
    expect(textA).toBe("hello world");

    // Alice appends.
    pA.doc.getText("body").insert(11, "!");
    const textB = await waitForContent(pB.doc, "body", (t) => t === "hello world!");
    expect(textB).toBe("hello world!");
  });

  it("late joiner receives full document state via registry key", async () => {
    const docId = "late-join-doc";
    const room = "test";

    const mintRes = await (
      await keyHandler(req("POST", `/keys/${docId}/mint`, { userId: "alice", room }))
    ).json();

    const { provider: pA } = await createProviderWithRegistryKey(
      docId,
      "alice",
      mintRes.wrappingKey,
    );
    await waitForSync(pA);

    pA.doc.getText("body").insert(0, "line 1");
    pA.doc.getText("title").insert(0, "My Document");
    await new Promise((r) => setTimeout(r, 1));

    // Grant bob after Alice has already written content.
    const grantRes = await (
      await keyHandler(req("POST", `/keys/${docId}/grant`, { userId: "bob", room }))
    ).json();

    const { provider: pB } = await createProviderWithRegistryKey(
      docId,
      "bob",
      grantRes.wrappingKey,
    );
    await waitForSync(pB);

    const body = await waitForContent(pB.doc, "body", (t) => t === "line 1");
    expect(body).toBe("line 1");

    const title = await waitForContent(pB.doc, "title", (t) => t === "My Document");
    expect(title).toBe("My Document");
  });

  it("server never sees plaintext — stored content is opaque", async () => {
    const docId = "opaque-doc";
    const room = "test";

    const mintRes = await (
      await keyHandler(req("POST", `/keys/${docId}/mint`, { userId: "alice", room }))
    ).json();

    const { provider: pA } = await createProviderWithRegistryKey(
      docId,
      "alice",
      mintRes.wrappingKey,
    );
    await waitForSync(pA);

    const secret = "top secret data that the server must not see";
    pA.doc.getText("body").insert(0, secret);
    await new Promise((r) => setTimeout(r, 1));

    // Inspect the server-side storage directly.
    const serverStorage = new MemoryDocumentStorage(true);
    const stored = await serverStorage.getDocument(`test/${docId}`);

    if (stored?.content.update) {
      const raw = new TextDecoder().decode(stored.content.update);
      expect(raw).not.toContain(secret);
    }
  });

  it("concurrent edits from both registry-keyed clients converge", async () => {
    const docId = "converge-doc";
    const room = "test";

    const mintRes = await (
      await keyHandler(req("POST", `/keys/${docId}/mint`, { userId: "alice", room }))
    ).json();
    const grantRes = await (
      await keyHandler(req("POST", `/keys/${docId}/grant`, { userId: "bob", room }))
    ).json();

    const { provider: pA } = await createProviderWithRegistryKey(
      docId,
      "alice",
      mintRes.wrappingKey,
    );
    await waitForSync(pA);

    pA.doc.getText("body").insert(0, "base");
    await new Promise((r) => setTimeout(r, 1));

    const { provider: pB } = await createProviderWithRegistryKey(
      docId,
      "bob",
      grantRes.wrappingKey,
    );
    await waitForSync(pB);
    await waitForContent(pB.doc, "body", (t) => t === "base");

    // Both edit concurrently.
    pA.doc.getText("body").insert(0, "A:");
    pB.doc.getText("body").insert(4, ":B");

    // Wait for convergence.
    await waitForContent(pA.doc, "body", (t) => t.includes("A:") && t.includes(":B"));
    await waitForContent(pB.doc, "body", (t) => t.includes("A:") && t.includes(":B"));

    expect(pA.doc.getText("body").toString()).toBe(pB.doc.getText("body").toString());
  });

  it("wrapping key derived server-side matches the one from HTTP mint", async () => {
    const docId = "derivation-check";
    const room = "test";

    const mintRes = await (
      await keyHandler(req("POST", `/keys/${docId}/mint`, { userId: "alice", room }))
    ).json();

    const fromHttp = await importWrappingKey(mintRes.wrappingKey);
    const fromDerive = await deriveWrappingKey(MASTER_SECRET, "alice");

    const exportedHttp = await crypto.subtle.exportKey("jwk", fromHttp);
    const exportedDerived = await crypto.subtle.exportKey("jwk", fromDerive);
    expect(exportedHttp.k).toBe(exportedDerived.k);
  });

  it("three clients with registry keys all converge", async () => {
    const docId = "three-way-doc";
    const room = "test";

    const mintRes = await (
      await keyHandler(req("POST", `/keys/${docId}/mint`, { userId: "alice", room }))
    ).json();
    const grantBob = await (
      await keyHandler(req("POST", `/keys/${docId}/grant`, { userId: "bob", room }))
    ).json();
    const grantCarol = await (
      await keyHandler(req("POST", `/keys/${docId}/grant`, { userId: "carol", room }))
    ).json();

    const { provider: pA } = await createProviderWithRegistryKey(
      docId,
      "alice",
      mintRes.wrappingKey,
    );
    await waitForSync(pA);

    pA.doc.getText("body").insert(0, "start");
    await new Promise((r) => setTimeout(r, 1));

    const { provider: pB } = await createProviderWithRegistryKey(
      docId,
      "bob",
      grantBob.wrappingKey,
    );
    await waitForSync(pB);
    await waitForContent(pB.doc, "body", (t) => t === "start");

    const { provider: pC } = await createProviderWithRegistryKey(
      docId,
      "carol",
      grantCarol.wrappingKey,
    );
    await waitForSync(pC);
    await waitForContent(pC.doc, "body", (t) => t === "start");

    // Each client appends.
    pA.doc.getText("body").insert(5, "-A");
    pB.doc.getText("body").insert(5, "-B");
    pC.doc.getText("body").insert(5, "-C");

    const hasSuffix = (t: string) => t.includes("-A") && t.includes("-B") && t.includes("-C");
    await waitForContent(pA.doc, "body", hasSuffix);
    await waitForContent(pB.doc, "body", hasSuffix);
    await waitForContent(pC.doc, "body", hasSuffix);

    const final = pA.doc.getText("body").toString();
    expect(pB.doc.getText("body").toString()).toBe(final);
    expect(pC.doc.getText("body").toString()).toBe(final);
  });
});
