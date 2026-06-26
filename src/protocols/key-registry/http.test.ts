import { describe, expect, it } from "bun:test";
import { InMemoryKeyRegistryStorage } from "../../storage/in-memory/key-registry-storage";
import { getKeyRegistryHandlers } from "./http";
import {
  deriveWrappingKey,
  unwrapDocumentKey,
  importWrappingKey,
} from "teleportal/encryption-key";

const MASTER_SECRET = crypto.getRandomValues(new Uint8Array(32));

function makeHandler() {
  const storage = new InMemoryKeyRegistryStorage();
  const handler = getKeyRegistryHandlers({ storage, masterSecret: MASTER_SECRET });
  return { storage, handler };
}

function req(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Key Registry HTTP Handlers", () => {
  it("should mint a document key and return a wrapping key", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generation).toBe(0);
    expect(typeof body.wrappingKey).toBe("string");
    expect(body.wrappingKey.length).toBeGreaterThan(0);
  });

  it("should grant access and return wrapping key for a single user", async () => {
    const { handler } = makeHandler();

    await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }));
    const res = await handler(
      req("POST", "/keys/doc-1/grant", { userId: "bob" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.wrappingKey).toBe("string");
  });

  it("should batch grant and return wrapping keys for multiple users", async () => {
    const { handler } = makeHandler();

    await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }));
    const res = await handler(
      req("POST", "/keys/doc-1/grant", { userIds: ["bob", "charlie"] }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wrappingKeys).toBeDefined();
    expect(typeof body.wrappingKeys.bob).toBe("string");
    expect(typeof body.wrappingKeys.charlie).toBe("string");
  });

  it("should return 404 when granting before minting", async () => {
    const { handler } = makeHandler();
    const res = await handler(
      req("POST", "/keys/doc-1/grant", { userId: "bob" }),
    );

    expect(res.status).toBe(404);
  });

  it("should return meta with generation and userIds", async () => {
    const { handler } = makeHandler();

    await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }));
    await handler(req("POST", "/keys/doc-1/grant", { userId: "bob" }));

    const res = await handler(req("GET", "/keys/doc-1/meta"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generation).toBe(0);
    expect(body.userIds.sort()).toEqual(["alice", "bob"]);
  });

  it("should revoke a user's key", async () => {
    const { handler } = makeHandler();

    await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }));
    await handler(req("POST", "/keys/doc-1/grant", { userId: "bob" }));
    await handler(
      req("DELETE", "/keys/doc-1/revoke", { userIds: ["bob"] }),
    );

    const res = await handler(req("GET", "/keys/doc-1/meta"));
    const body = await res.json();
    expect(body.userIds).toEqual(["alice"]);
  });

  it("should rotate the key and bump generation", async () => {
    const { handler } = makeHandler();

    await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }));
    await handler(req("POST", "/keys/doc-1/grant", { userId: "bob" }));

    const res = await handler(
      req("POST", "/keys/doc-1/rotate", { excludeUserIds: ["bob"] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generation).toBe(1);

    const meta = await (await handler(req("GET", "/keys/doc-1/meta"))).json();
    expect(meta.generation).toBe(1);
    expect(meta.userIds).toEqual(["alice"]);
  });

  it("should produce wrapping keys that can unwrap the document key", async () => {
    const { handler, storage } = makeHandler();

    const mintRes = await (
      await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }))
    ).json();

    const wrappingKey = await importWrappingKey(mintRes.wrappingKey);
    const record = await storage.get("doc-1", "alice");
    expect(record).not.toBeNull();

    const documentKey = await unwrapDocumentKey(wrappingKey, record!.wrappedKey);
    expect(documentKey.algorithm).toHaveProperty("name", "AES-GCM");
  });

  it("should produce wrapping keys matching HKDF derivation", async () => {
    const { handler } = makeHandler();

    const mintRes = await (
      await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }))
    ).json();
    const grantRes = await (
      await handler(req("POST", "/keys/doc-1/grant", { userId: "bob" }))
    ).json();

    const aliceDerived = await deriveWrappingKey(MASTER_SECRET, "alice");
    const bobDerived = await deriveWrappingKey(MASTER_SECRET, "bob");

    const aliceExpected = await crypto.subtle.exportKey("jwk", aliceDerived);
    const bobExpected = await crypto.subtle.exportKey("jwk", bobDerived);

    const aliceReturned = await crypto.subtle.exportKey(
      "jwk",
      await importWrappingKey(mintRes.wrappingKey),
    );
    const bobReturned = await crypto.subtle.exportKey(
      "jwk",
      await importWrappingKey(grantRes.wrappingKey),
    );

    expect(aliceReturned.k).toBe(aliceExpected.k);
    expect(bobReturned.k).toBe(bobExpected.k);
  });

  it("should return 404 for unknown actions", async () => {
    const { handler } = makeHandler();
    const res = await handler(req("GET", "/keys/doc-1/unknown"));
    expect(res.status).toBe(404);
  });

  it("should call authorize hook when provided", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    const handler = getKeyRegistryHandlers({
      storage,
      masterSecret: MASTER_SECRET,
      authorize: async (_req, _docId, action) => action !== "mint",
    });

    const res = await handler(
      req("POST", "/keys/doc-1/mint", { userId: "alice" }),
    );
    expect(res.status).toBe(403);
  });

  it("should namespace documentId with room when provided", async () => {
    const { handler, storage } = makeHandler();

    await handler(
      req("POST", "/keys/doc-1/mint", { userId: "alice", room: "myroom" }),
    );

    // Key should be stored under the composite ID
    const record = await storage.get("myroom/doc-1", "alice");
    expect(record).not.toBeNull();

    // Not under the raw ID
    const raw = await storage.get("doc-1", "alice");
    expect(raw).toBeNull();
  });

  describe("full lifecycle", () => {
    it("mint → grant → revoke → rotate", async () => {
      const { handler } = makeHandler();

      // Mint
      const mint = await (
        await handler(req("POST", "/keys/doc-1/mint", { userId: "alice" }))
      ).json();
      expect(mint.generation).toBe(0);

      // Grant bob and charlie
      await handler(
        req("POST", "/keys/doc-1/grant", {
          userIds: ["bob", "charlie"],
        }),
      );

      // Verify meta
      let meta = await (await handler(req("GET", "/keys/doc-1/meta"))).json();
      expect(meta.userIds.sort()).toEqual(["alice", "bob", "charlie"]);

      // Revoke charlie
      await handler(
        req("DELETE", "/keys/doc-1/revoke", { userIds: ["charlie"] }),
      );

      // Rotate (excludes charlie)
      const rotate = await (
        await handler(
          req("POST", "/keys/doc-1/rotate", {
            excludeUserIds: ["charlie"],
          }),
        )
      ).json();
      expect(rotate.generation).toBe(1);

      // Final meta
      meta = await (await handler(req("GET", "/keys/doc-1/meta"))).json();
      expect(meta.generation).toBe(1);
      expect(meta.userIds.sort()).toEqual(["alice", "bob"]);
    });
  });
});
