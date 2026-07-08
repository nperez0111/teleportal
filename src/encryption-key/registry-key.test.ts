import { describe, expect, it } from "bun:test";
import { generateEncryptionKey, encryptUpdate, decryptUpdate } from "./index";
import { deriveWrappingKey, wrapDocumentKey } from "./key-wrapping";
import { registryKey } from "./key-resolver";
import { RpcMessage } from "teleportal/protocol";

const MASTER_SECRET = crypto.getRandomValues(new Uint8Array(32));

/**
 * Create a mock connection that responds to `keysGet` with the provided
 * wrapped key data. Simulates the server RPC round-trip.
 */
function createMockConnection(responses: Map<string, any>) {
  const listeners = new Set<(message: any) => void>();

  return {
    on(event: string, callback: (message: any) => void) {
      if (event === "received-message") {
        listeners.add(callback);
      }
      return () => listeners.delete(callback);
    },
    async send(message: any) {
      if (message.type !== "rpc" || message.requestType !== "request") return;

      const method = message.rpcMethod;
      const responseData = responses.get(method);

      if (!responseData) {
        const errorMsg = new RpcMessage(
          message.document,
          { type: "error" as const, statusCode: 404, details: "Not found" },
          method,
          "response",
          message.id,
          {},
          false,
        );
        setTimeout(() => {
          for (const listener of listeners) listener(errorMsg);
        }, 0);
        return;
      }

      const response = new RpcMessage(
        message.document,
        { type: "success" as const, payload: responseData },
        method,
        "response",
        message.id,
        {},
        false,
      );
      setTimeout(() => {
        for (const listener of listeners) listener(response);
      }, 0);
    },
    connected: Promise.resolve(),
  };
}

describe("registryKey", () => {
  it("should fetch and unwrap the document key from the registry", async () => {
    const documentKey = await generateEncryptionKey();
    const wrappingKey = await deriveWrappingKey(MASTER_SECRET, "alice");
    const wrappedKey = await wrapDocumentKey(wrappingKey, documentKey);

    const conn = createMockConnection(new Map([["keysGet", { wrappedKey, generation: 0 }]]));

    const resolver = registryKey({ wrappingKey });
    const resolved = await resolver.resolve({
      document: "doc-1",
      connection: conn as any,
    });

    const originalExported = await crypto.subtle.exportKey("jwk", documentKey);
    const resolvedExported = await crypto.subtle.exportKey("jwk", resolved);
    expect(resolvedExported.k).toBe(originalExported.k);
  });

  it("should produce a usable AES-GCM key", async () => {
    const documentKey = await generateEncryptionKey();
    const wrappingKey = await deriveWrappingKey(MASTER_SECRET, "alice");
    const wrappedKey = await wrapDocumentKey(wrappingKey, documentKey);

    const conn = createMockConnection(new Map([["keysGet", { wrappedKey, generation: 0 }]]));

    const resolver = registryKey({ wrappingKey });
    const resolved = await resolver.resolve({
      document: "doc-1",
      connection: conn as any,
    });

    const plaintext = new Uint8Array([10, 20, 30, 40, 50]);
    const encrypted = await encryptUpdate(resolved, plaintext);
    const decrypted = await decryptUpdate(resolved, encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it("should cache the resolved key on subsequent calls", async () => {
    const documentKey = await generateEncryptionKey();
    const wrappingKey = await deriveWrappingKey(MASTER_SECRET, "alice");
    const wrappedKey = await wrapDocumentKey(wrappingKey, documentKey);

    const conn = createMockConnection(new Map([["keysGet", { wrappedKey, generation: 0 }]]));

    const resolver = registryKey({ wrappingKey });
    const key1 = await resolver.resolve({
      document: "doc-1",
      connection: conn as any,
    });
    const key2 = await resolver.resolve({
      document: "doc-1",
      connection: conn as any,
    });

    expect(key1).toBe(key2);
  });

  it("should accept a wrappingKey factory function", async () => {
    const documentKey = await generateEncryptionKey();
    const wrappingKey = await deriveWrappingKey(MASTER_SECRET, "alice");
    const wrappedKey = await wrapDocumentKey(wrappingKey, documentKey);

    const conn = createMockConnection(new Map([["keysGet", { wrappedKey, generation: 0 }]]));

    const resolver = registryKey({
      wrappingKey: async () => wrappingKey,
    });
    const resolved = await resolver.resolve({
      document: "doc-1",
      connection: conn as any,
    });

    const originalExported = await crypto.subtle.exportKey("jwk", documentKey);
    const resolvedExported = await crypto.subtle.exportKey("jwk", resolved);
    expect(resolvedExported.k).toBe(originalExported.k);
  });

  it("should invalidate cached key via _invalidate", async () => {
    const documentKey = await generateEncryptionKey();
    const wrappingKey = await deriveWrappingKey(MASTER_SECRET, "alice");
    const wrappedKey = await wrapDocumentKey(wrappingKey, documentKey);

    let rpcCallCount = 0;
    const conn = {
      on(event: string, callback: (message: any) => void) {
        const listeners = new Set<(message: any) => void>();
        if (event === "received-message") listeners.add(callback);
        (conn as any)._listeners = listeners;
        return () => listeners.delete(callback);
      },
      async send(message: any) {
        if (message.type !== "rpc") return;
        rpcCallCount++;
        const response = new RpcMessage(
          message.document,
          { type: "success" as const, payload: { wrappedKey, generation: rpcCallCount - 1 } },
          message.rpcMethod,
          "response",
          message.id,
          {},
          false,
        );
        setTimeout(() => {
          for (const listener of (conn as any)._listeners) listener(response);
        }, 0);
      },
      connected: Promise.resolve(),
    };

    const resolver = registryKey({ wrappingKey }) as any;

    await resolver.resolve({ document: "doc-1", connection: conn });
    expect(rpcCallCount).toBe(1);

    // Cached — no new RPC
    await resolver.resolve({ document: "doc-1", connection: conn });
    expect(rpcCallCount).toBe(1);

    // Invalidate
    resolver._invalidate("doc-1");

    // Re-fetches
    await resolver.resolve({ document: "doc-1", connection: conn });
    expect(rpcCallCount).toBe(2);
  });

  it("should call onInvalidate callback when invalidated", async () => {
    const resolver = registryKey({
      wrappingKey: await deriveWrappingKey(MASTER_SECRET, "alice"),
    }) as any;

    let invalidatedDoc: string | undefined;
    resolver.onInvalidate?.((doc: string) => {
      invalidatedDoc = doc;
    });

    resolver._invalidate("doc-42");
    expect(invalidatedDoc).toBe("doc-42");
  });

  it("should resolve DISTINCT keys per document on a shared resolver instance", async () => {
    // A single resolver instance is reused across documents opened on the same
    // connection (Provider.openDocumentAsync). The per-document key must not be
    // cached globally, or document B would be handed document A's key.
    const wrappingKey = await deriveWrappingKey(MASTER_SECRET, "alice");

    const keyA = await generateEncryptionKey();
    const keyB = await generateEncryptionKey();
    const wrappedA = await wrapDocumentKey(wrappingKey, keyA);
    const wrappedB = await wrapDocumentKey(wrappingKey, keyB);

    // Document-aware mock: returns the wrapped key registered for the requested
    // document, so a resolver that ignores `document` would be caught.
    const perDoc = new Map<string, Uint8Array>([
      ["doc-a", wrappedA],
      ["doc-b", wrappedB],
    ]);
    const listeners = new Set<(m: any) => void>();
    const conn = {
      on(event: string, cb: (m: any) => void) {
        if (event === "received-message") listeners.add(cb);
        return () => listeners.delete(cb);
      },
      async send(message: any) {
        if (message.type !== "rpc" || message.requestType !== "request") return;
        const wrappedKey = perDoc.get(message.document);
        const response = new RpcMessage(
          message.document,
          { type: "success" as const, payload: { wrappedKey, generation: 0 } },
          message.rpcMethod,
          "response",
          message.id,
          {},
          false,
        );
        setTimeout(() => {
          for (const l of listeners) l(response);
        }, 0);
      },
      connected: Promise.resolve(),
    };

    const resolver = registryKey({ wrappingKey });
    const resolvedA = await resolver.resolve({ document: "doc-a", connection: conn as any });
    const resolvedB = await resolver.resolve({ document: "doc-b", connection: conn as any });

    const [ea, eb, oa, ob] = await Promise.all([
      crypto.subtle.exportKey("jwk", resolvedA),
      crypto.subtle.exportKey("jwk", resolvedB),
      crypto.subtle.exportKey("jwk", keyA),
      crypto.subtle.exportKey("jwk", keyB),
    ]);
    expect(ea.k).toBe(oa.k);
    expect(eb.k).toBe(ob.k);
    expect(ea.k).not.toBe(eb.k);
  });

  it("should cache per document (repeat resolve of same doc reuses key)", async () => {
    const wrappingKey = await deriveWrappingKey(MASTER_SECRET, "alice");
    const keyA = await generateEncryptionKey();
    const wrappedA = await wrapDocumentKey(wrappingKey, keyA);

    let rpcCallCount = 0;
    const listeners = new Set<(m: any) => void>();
    const conn = {
      on(event: string, cb: (m: any) => void) {
        if (event === "received-message") listeners.add(cb);
        return () => listeners.delete(cb);
      },
      async send(message: any) {
        if (message.type !== "rpc" || message.requestType !== "request") return;
        rpcCallCount++;
        const response = new RpcMessage(
          message.document,
          { type: "success" as const, payload: { wrappedKey: wrappedA, generation: 0 } },
          message.rpcMethod,
          "response",
          message.id,
          {},
          false,
        );
        setTimeout(() => {
          for (const l of listeners) l(response);
        }, 0);
      },
      connected: Promise.resolve(),
    };

    const resolver = registryKey({ wrappingKey });
    const k1 = await resolver.resolve({ document: "doc-a", connection: conn as any });
    const k2 = await resolver.resolve({ document: "doc-a", connection: conn as any });
    expect(k1).toBe(k2);
    expect(rpcCallCount).toBe(1);
  });

  it("_invalidate only clears the named document's cached key", async () => {
    const wrappingKey = await deriveWrappingKey(MASTER_SECRET, "alice");
    const keyA = await generateEncryptionKey();
    const keyB = await generateEncryptionKey();
    const wrappedA = await wrapDocumentKey(wrappingKey, keyA);
    const wrappedB = await wrapDocumentKey(wrappingKey, keyB);

    const perDoc = new Map<string, Uint8Array>([
      ["doc-a", wrappedA],
      ["doc-b", wrappedB],
    ]);
    const callsByDoc = new Map<string, number>();
    const listeners = new Set<(m: any) => void>();
    const conn = {
      on(event: string, cb: (m: any) => void) {
        if (event === "received-message") listeners.add(cb);
        return () => listeners.delete(cb);
      },
      async send(message: any) {
        if (message.type !== "rpc" || message.requestType !== "request") return;
        callsByDoc.set(message.document, (callsByDoc.get(message.document) ?? 0) + 1);
        const response = new RpcMessage(
          message.document,
          {
            type: "success" as const,
            payload: { wrappedKey: perDoc.get(message.document), generation: 0 },
          },
          message.rpcMethod,
          "response",
          message.id,
          {},
          false,
        );
        setTimeout(() => {
          for (const l of listeners) l(response);
        }, 0);
      },
      connected: Promise.resolve(),
    };

    const resolver = registryKey({ wrappingKey }) as any;
    await resolver.resolve({ document: "doc-a", connection: conn });
    await resolver.resolve({ document: "doc-b", connection: conn });
    expect(callsByDoc.get("doc-a")).toBe(1);
    expect(callsByDoc.get("doc-b")).toBe(1);

    // Invalidate only doc-a.
    resolver._invalidate("doc-a");

    await resolver.resolve({ document: "doc-a", connection: conn });
    await resolver.resolve({ document: "doc-b", connection: conn });
    // doc-a re-fetched, doc-b still cached.
    expect(callsByDoc.get("doc-a")).toBe(2);
    expect(callsByDoc.get("doc-b")).toBe(1);
  });
});
