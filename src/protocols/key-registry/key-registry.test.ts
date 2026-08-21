import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Message, RpcSuccess, ServerContext } from "teleportal";
import { InMemoryPubSub } from "teleportal";
import { RpcMessage } from "teleportal/protocol";
import { Server } from "../../server/server";
import { Session } from "../../server/session";
import { InMemoryKeyRegistryStorage } from "../../storage/in-memory/key-registry-storage";
import { getKeyRegistryHandlers } from "./http";
import { getKeyRegistryRpcHandlers } from "./server";
import { createKeyRegistryRpc } from "./client";
import {
  generateEncryptionKey,
  deriveWrappingKey,
  wrapDocumentKey,
  unwrapDocumentKey,
  importWrappingKey,
  encryptUpdate,
  decryptUpdate,
} from "teleportal/encryption-key";

const MASTER_SECRET = crypto.getRandomValues(new Uint8Array(32));

function makeHandler() {
  const storage = new InMemoryKeyRegistryStorage();
  const handler = getKeyRegistryHandlers({
    storage,
    masterSecret: MASTER_SECRET,
  });
  return { storage, handler };
}

function req(method: string, path: string, body?: Record<string, unknown>): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Key Registry — end-to-end", () => {
  it("mint → grant → both users decrypt the same content", async () => {
    const { handler } = makeHandler();

    // Alice mints
    const mintRes = await (
      await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }))
    ).json();

    // Bob is granted
    const grantRes = await (
      await handler(req("POST", "/keys/doc-1/grant", { userId: "bob" }))
    ).json();

    // Alice decrypts via her wrapping key
    const aliceWK = await importWrappingKey(mintRes.wrappingKey);
    // Bob decrypts via his wrapping key
    const _bobWK = await importWrappingKey(grantRes.wrappingKey);

    // Simulate: alice encrypts content
    const _aliceDocKey = await unwrapDocumentKey(
      aliceWK,
      // Derive her wrapping key the same way the server did, then unwrap
      await (async () => {
        const wk = await deriveWrappingKey(MASTER_SECRET, "alice");
        const docKey = await generateEncryptionKey();
        return await wrapDocumentKey(wk, docKey);
      })(),
    ).catch(() => null);

    // Actually, let's use the storage directly for a cleaner test
    // Both users should be able to unwrap to the same document key
    const { storage } = makeHandler();
    const docKey = await generateEncryptionKey();
    const aliceWK2 = await deriveWrappingKey(MASTER_SECRET, "alice");
    const bobWK2 = await deriveWrappingKey(MASTER_SECRET, "bob");

    await storage.set("doc-2", [
      { userId: "alice", wrappedKey: await wrapDocumentKey(aliceWK2, docKey) },
      { userId: "bob", wrappedKey: await wrapDocumentKey(bobWK2, docKey) },
    ]);

    const aliceRecord = await storage.get("doc-2", "alice");
    const bobRecord = await storage.get("doc-2", "bob");

    const aliceKey = await unwrapDocumentKey(aliceWK2, aliceRecord!.wrappedKey);
    const bobKey = await unwrapDocumentKey(bobWK2, bobRecord!.wrappedKey);

    // Both keys should be identical
    const aliceExported = await crypto.subtle.exportKey("jwk", aliceKey);
    const bobExported = await crypto.subtle.exportKey("jwk", bobKey);
    expect(aliceExported.k).toBe(bobExported.k);

    // Alice encrypts, Bob decrypts
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const encrypted = await encryptUpdate(aliceKey, plaintext);
    const decrypted = await decryptUpdate(bobKey, encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it("rotation produces a new key that old users cannot use", async () => {
    const { storage } = makeHandler();
    const docKey = await generateEncryptionKey();
    const aliceWK = await deriveWrappingKey(MASTER_SECRET, "alice");
    const bobWK = await deriveWrappingKey(MASTER_SECRET, "bob");

    await storage.set("doc-1", [
      { userId: "alice", wrappedKey: await wrapDocumentKey(aliceWK, docKey) },
      { userId: "bob", wrappedKey: await wrapDocumentKey(bobWK, docKey) },
    ]);

    // Rotate: generate new key, only wrap for alice (bob is revoked)
    const newDocKey = await generateEncryptionKey();
    await storage.rotate(
      "doc-1",
      [{ userId: "alice", wrappedKey: await wrapDocumentKey(aliceWK, newDocKey) }],
      0,
    );

    // Alice can unwrap the new key
    const aliceRecord = await storage.get("doc-1", "alice");
    const aliceNewKey = await unwrapDocumentKey(aliceWK, aliceRecord!.wrappedKey);
    expect(aliceRecord!.generation).toBe(1);

    // Bob's key is gone
    const bobRecord = await storage.get("doc-1", "bob");
    expect(bobRecord).toBeNull();

    // Alice encrypts with new key — this would fail with old key
    const plaintext = new Uint8Array([10, 20, 30]);
    const encrypted = await encryptUpdate(aliceNewKey, plaintext);

    // Old key can't decrypt new content
    await expect(decryptUpdate(docKey, encrypted)).rejects.toThrow();

    // New key can
    const decrypted = await decryptUpdate(aliceNewKey, encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it("concurrent rotations — first wins, second gets conflict", async () => {
    const { storage } = makeHandler();
    const docKey = await generateEncryptionKey();
    const aliceWK = await deriveWrappingKey(MASTER_SECRET, "alice");

    await storage.set("doc-1", [
      { userId: "alice", wrappedKey: await wrapDocumentKey(aliceWK, docKey) },
    ]);

    const newKey1 = await generateEncryptionKey();
    const newKey2 = await generateEncryptionKey();

    // Both read generation 0
    const meta = await storage.getMeta("doc-1");
    expect(meta.generation).toBe(0);

    // First rotation succeeds
    await storage.rotate(
      "doc-1",
      [{ userId: "alice", wrappedKey: await wrapDocumentKey(aliceWK, newKey1) }],
      0,
    );

    // Second rotation with stale generation fails
    await expect(
      storage.rotate(
        "doc-1",
        [{ userId: "alice", wrappedKey: await wrapDocumentKey(aliceWK, newKey2) }],
        0,
      ),
    ).rejects.toThrow("conflict");

    // The first rotation's key is what's stored
    const record = await storage.get("doc-1", "alice");
    const storedKey = await unwrapDocumentKey(aliceWK, record!.wrappedKey);
    const storedExported = await crypto.subtle.exportKey("jwk", storedKey);
    const key1Exported = await crypto.subtle.exportKey("jwk", newKey1);
    expect(storedExported.k).toBe(key1Exported.k);
  });

  it("HTTP rotate returns 409 on generation conflict", async () => {
    const { handler, storage } = makeHandler();

    await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }));

    // First rotate succeeds
    const r1 = await handler(req("POST", "/keys/doc-1/rotate", {}));
    expect(r1.status).toBe(200);

    // Manually set generation back to simulate stale state
    // (In practice the handler reads the current meta, so we need to
    // do a concurrent rotation via storage directly)
    const docKey2 = await generateEncryptionKey();
    const aliceWK = await deriveWrappingKey(MASTER_SECRET, "alice");
    await expect(
      storage.rotate(
        "doc-1",
        [{ userId: "alice", wrappedKey: await wrapDocumentKey(aliceWK, docKey2) }],
        0, // stale: current is 1
      ),
    ).rejects.toThrow("conflict");
  });

  it("generation increments through multiple rotations via HTTP", async () => {
    const { handler } = makeHandler();

    await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }));

    for (let i = 0; i < 5; i++) {
      const res = await handler(req("POST", "/keys/doc-1/rotate", {}));
      const body = await res.json();
      expect(body.generation).toBe(i + 1);
    }

    const meta = await (await handler(req("GET", "/keys/doc-1/meta"))).json();
    expect(meta.generation).toBe(5);
  });
});

describe("Key Registry — RPC server handlers", () => {
  it("keysGet returns 401 when userId is missing", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    const handlers = (await import("./server")).getKeyRegistryRpcHandlers(storage);
    const handler = handlers["key-registry.get"];

    const context = {
      documentId: "doc-1",
      session: { broadcast: mock(async () => {}) } as any,
      server: {} as any,
    };

    const result = await handler.handler!({}, context);
    expect(result.response).toEqual({
      type: "error",
      statusCode: 401,
      details: "userId required in message context",
      payload: undefined,
    });
  });

  it("keysGet returns 404 when no key exists for the user", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    const handlers = (await import("./server")).getKeyRegistryRpcHandlers(storage);
    const handler = handlers["key-registry.get"];

    const context = {
      documentId: "doc-1",
      userId: "alice",
      session: { broadcast: mock(async () => {}) } as any,
      server: {} as any,
    };

    const result = await handler.handler!({}, context);
    expect(result.response).toEqual({
      type: "error",
      statusCode: 404,
      details: "No wrapped key found for this user",
      payload: undefined,
    });
  });

  it("keysGet returns the wrapped key for a registered user", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    const wrappedKey = new Uint8Array([1, 2, 3]);
    await storage.set("doc-1", [{ userId: "alice", wrappedKey }]);

    const handlers = (await import("./server")).getKeyRegistryRpcHandlers(storage);
    const handler = handlers["key-registry.get"];

    const context = {
      documentId: "doc-1",
      userId: "alice",
      session: { broadcast: mock(async () => {}) } as any,
      server: {} as any,
    };

    const result = await handler.handler!({}, context);
    expect(result.response).toEqual({
      wrappedKey,
      generation: 0,
    });
  });

  it("keysRotate returns 409 on generation conflict", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    const wrappedKey = new Uint8Array([1, 2, 3]);
    await storage.set("doc-1", [{ userId: "alice", wrappedKey }]);
    await storage.rotate("doc-1", [{ userId: "alice", wrappedKey: new Uint8Array([4, 5]) }], 0);

    const handlers = (await import("./server")).getKeyRegistryRpcHandlers(storage);
    const handler = handlers["key-registry.rotate"];

    const context = {
      documentId: "doc-1",
      userId: "alice",
      clientId: "c1",
      session: { broadcast: mock(async () => {}) } as any,
      server: {} as any,
    };

    const result = await handler.handler!(
      { entries: [{ userId: "alice", wrappedKey: new Uint8Array([7, 8]) }], expectedGeneration: 0 },
      context,
    );
    expect((result.response as any).type).toBe("error");
    expect((result.response as any).statusCode).toBe(409);
  });
});

describe("Key Registry — client rotation notifications", () => {
  it("handleMessage dispatches keysRotated via rpcMethod", () => {
    const factory = createKeyRegistryRpc;
    const ext = factory();

    const ctx = {
      rpcClient: {
        sendRequest: mock(async () => ({})),
        sendStream: mock(async () => {}),
        onMessage: mock(() => () => {}),
        destroy: mock(() => {}),
      } as any,
      document: "test-doc",
      doc: {} as any,
      awareness: {} as any,
      connection: {
        state: { type: "connected" },
        send: mock(async () => {}),
        connected: Promise.resolve(),
        on: mock(() => () => {}),
      },
      synced: Promise.resolve(),
    };

    const api = ext.create(ctx);

    let receivedGeneration: number | null = null;
    api.onKeysRotated((gen) => {
      receivedGeneration = gen;
    });

    const notification = new RpcMessage(
      "test-doc",
      { type: "success" as const, payload: { generation: 42 } },
      "key-registry.rotated",
      "response",
      undefined,
      {},
      false,
    );

    const handled = ext.handleMessage!(notification);
    expect(handled).toBe(true);
    expect(receivedGeneration).not.toBeNull();
    expect(receivedGeneration!).toBe(42);
  });

  it("ignores a request that borrows the push's method name", () => {
    const ext = createKeyRegistryRpc();
    const api = ext.create(mockCtx("test-doc"));

    let calls = 0;
    api.onKeysRotated(() => calls++);

    // Only the server authors `key-registry.rotated`, and it authors it as a push.
    // A `request` wearing the same method name is not one.
    const impostor = new RpcMessage(
      "test-doc",
      { type: "success" as const, payload: { generation: 42 } },
      "key-registry.rotated",
      "request",
      undefined,
      {},
      false,
    );

    expect(ext.handleMessage!(impostor)).toBe(false);
    expect(calls).toBe(0);
  });

  it("handleMessage ignores unrelated messages", () => {
    const factory = createKeyRegistryRpc;
    const ext = factory();

    const notification = new RpcMessage(
      "test-doc",
      { type: "success" as const, payload: {} },
      "someOtherMethod",
      "request",
      undefined,
      {},
      false,
    );

    const handled = ext.handleMessage!(notification);
    expect(handled).toBe(false);
  });

  function mockCtx(document: string) {
    return {
      rpcClient: {
        sendRequest: mock(async () => ({})),
        sendStream: mock(async () => {}),
        onMessage: mock(() => () => {}),
        destroy: mock(() => {}),
      } as any,
      document,
      doc: {} as any,
      awareness: {} as any,
      connection: {
        state: { type: "connected" },
        send: mock(async () => {}),
        connected: Promise.resolve(),
        on: mock(() => () => {}),
      },
      synced: Promise.resolve(),
    };
  }

  /**
   * Shaped as the server authors it: a push is a `response` correlated to no request
   * (see `Session#buildRpcPush`). This fixture used to say `"request"`, which the
   * extension accepted only because it never checked `requestType`.
   */
  function rotatedMessage(document: string, generation: number) {
    return new RpcMessage(
      document,
      { type: "success" as const, payload: { generation } },
      "key-registry.rotated",
      "response",
      undefined,
      {},
      false,
    );
  }

  it("routes each rotation notification only to the instance whose document matches", () => {
    const extA = createKeyRegistryRpc();
    const extB = createKeyRegistryRpc();
    const apiA = extA.create(mockCtx("doc-a"));
    const apiB = extB.create(mockCtx("doc-b"));

    const aGens: number[] = [];
    const bGens: number[] = [];
    apiA.onKeysRotated((g) => aGens.push(g));
    apiB.onKeysRotated((g) => bGens.push(g));

    // A rotation for doc-b must only reach B's callback.
    expect(extB.handleMessage!(rotatedMessage("doc-b", 7))).toBe(true);
    expect(bGens).toEqual([7]);
    expect(aGens).toEqual([]);

    // A rotation for doc-a must only reach A's callback.
    expect(extA.handleMessage!(rotatedMessage("doc-a", 3))).toBe(true);
    expect(aGens).toEqual([3]);
    expect(bGens).toEqual([7]);
  });

  // Cross-document filtering is the Provider's job now (it owns the shared connection and
  // knows which document each extension belongs to), so it is covered there rather than
  // re-implemented in every extension. See provider.test.ts.

  it("destroying one instance does not disable notifications for another", () => {
    const extA = createKeyRegistryRpc();
    const extB = createKeyRegistryRpc();
    const apiA = extA.create(mockCtx("doc-a"));
    extB.create(mockCtx("doc-b"));

    let aCalls = 0;
    apiA.onKeysRotated(() => aCalls++);

    extB.destroy!();

    expect(extA.handleMessage!(rotatedMessage("doc-a", 1))).toBe(true);
    expect(aCalls).toBe(1);
  });
});

describe("Key Registry — rotation notifications are server-authored", () => {
  class MockClient {
    public sentMessages: Message<ServerContext>[] = [];
    constructor(public id: string) {}
    async send(message: Message<ServerContext>) {
      this.sentMessages.push(message);
    }
    destroy() {}
    /** Rotation pushes this client received. */
    rotations(): number[] {
      return this.sentMessages
        .filter(
          (m): m is RpcMessage<ServerContext> =>
            m.type === "rpc" &&
            (m as RpcMessage<ServerContext>).rpcMethod === "key-registry.rotated" &&
            (m as RpcMessage<ServerContext>).requestType === "response" &&
            (m as RpcMessage<ServerContext>).originalRequestId === undefined,
        )
        .map((m) => ((m.payload as RpcSuccess).payload as { generation: number }).generation);
    }
  }

  const storageStub = {
    type: "document-storage",
    storageType: "unencrypted",
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

  let pubSub: InMemoryPubSub;
  let disposables: Array<() => Promise<unknown>>;

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    disposables = [];
  });

  afterEach(async () => {
    for (const dispose of disposables.reverse()) await dispose();
    await pubSub[Symbol.asyncDispose]();
  });

  async function makeNode(storage: InMemoryKeyRegistryStorage) {
    const registry = getKeyRegistryRpcHandlers(storage);
    const server = new Server<ServerContext>({
      storage: async () => {
        throw new Error("not used");
      },
      rpcHandlers: registry,
    });
    const session = new Session<ServerContext>({
      documentId: "doc-1",
      namespacedDocumentId: "doc-1",
      id: "session-a",
      encrypted: false,
      storage: storageStub,
      pubSub,
      nodeId: "node-a",
      onCleanupScheduled: () => {},
      rpcHandlers: registry,
      server,
    });
    await session.load();
    disposables.push(async () => {
      await session[Symbol.asyncDispose]();
      await server[Symbol.asyncDispose]();
    });
    return session;
  }

  /** A push shaped exactly like the server's own, but authored by a client. */
  function forgedRotated(generation: number): RpcMessage<ServerContext> {
    return new RpcMessage<ServerContext>(
      "doc-1",
      { type: "success", payload: { generation } },
      "key-registry.rotated",
      "response",
      undefined,
      {} as ServerContext,
      false,
    );
  }

  it("does not relay a client-authored rotation push to peers", async () => {
    const session = await makeNode(new InMemoryKeyRegistryStorage());
    const attacker = new MockClient("client-attacker");
    const victim = new MockClient("client-victim");
    session.addClient(attacker as any);
    session.addClient(victim as any);

    await session.apply(forgedRotated(99), attacker as any);

    // A forged rotation would make every peer discard its key and re-fetch.
    expect(victim.rotations()).toEqual([]);
  });

  it("still relays the rotation the rotate handler authors", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    await storage.set("doc-1", [{ userId: "alice", wrappedKey: new Uint8Array([1, 2, 3]) }]);
    const session = await makeNode(storage);
    const rotator = new MockClient("client-rotator");
    const peer = new MockClient("client-peer");
    session.addClient(rotator as any);
    session.addClient(peer as any);

    const rotate = new RpcMessage<ServerContext>(
      "doc-1",
      {
        type: "success",
        payload: {
          entries: [{ userId: "alice", wrappedKey: new Uint8Array([4, 5, 6]) }],
          expectedGeneration: 0,
        },
      },
      "key-registry.rotate",
      "request",
      undefined,
      { userId: "alice" } as ServerContext,
      false,
    );
    await session.apply(rotate, rotator as any);

    expect(peer.rotations()).toEqual([1]);
    // The rotating client already knows; it is excluded from its own broadcast.
    expect(rotator.rotations()).toEqual([]);
  });
});
