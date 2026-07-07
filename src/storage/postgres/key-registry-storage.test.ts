import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { KeyRotationConflictError, PostgresKeyRegistryStorage } from "./key-registry-storage";
import { dropSchema, ensureSchema } from "./schema";
import { isPostgresAvailable, makeTestSql, randomTablePrefix } from "./test-utils";
import type { Sql } from "./types";

let available = false;
let sql: (Sql & { end(): Promise<void> }) | undefined;
const prefix = randomTablePrefix();
const storages: PostgresKeyRegistryStorage[] = [];

function makeStorage(options?: { lockTimeoutMs?: number }) {
  const storage = new PostgresKeyRegistryStorage(sql!, { tablePrefix: prefix, ...options });
  storages.push(storage);
  return storage;
}

function wrap(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function docId(): string {
  return `doc-${crypto.randomUUID()}`;
}

beforeAll(async () => {
  available = await isPostgresAvailable();
  if (!available) return;
  // Each adapter instance that runs a transaction() reserves one dedicated
  // lock connection, so the pool must be larger than the number of
  // concurrently open instances in this file.
  sql = makeTestSql(10);
  await ensureSchema(sql, { tablePrefix: prefix });
});

afterAll(async () => {
  for (const storage of storages) {
    await storage.close();
  }
  if (sql) {
    await dropSchema(sql, { tablePrefix: prefix });
    await sql.end();
  }
});

describe("PostgresKeyRegistryStorage", () => {
  it("returns null for unknown document/user", async () => {
    if (!available) return;
    const storage = makeStorage();
    const doc = docId();
    expect(await storage.get(doc, "alice")).toBeNull();
    expect(await storage.getAny(doc)).toBeNull();
  });

  it("sets and gets a wrapped key", async () => {
    if (!available) return;
    const storage = makeStorage();
    const doc = docId();
    await storage.set(doc, [{ userId: "alice", wrappedKey: wrap("key-a") }]);

    const result = await storage.get(doc, "alice");
    expect(result).not.toBeNull();
    expect(result!.wrappedKey).toEqual(wrap("key-a"));
    expect(result!.generation).toBe(0);
  });

  it("sets multiple entries at once", async () => {
    if (!available) return;
    const storage = makeStorage();
    const doc = docId();
    await storage.set(doc, [
      { userId: "alice", wrappedKey: wrap("key-a") },
      { userId: "bob", wrappedKey: wrap("key-b") },
    ]);

    expect((await storage.get(doc, "alice"))!.wrappedKey).toEqual(wrap("key-a"));
    expect((await storage.get(doc, "bob"))!.wrappedKey).toEqual(wrap("key-b"));
  });

  it("upserts on repeated set", async () => {
    if (!available) return;
    const storage = makeStorage();
    const doc = docId();
    await storage.set(doc, [{ userId: "alice", wrappedKey: wrap("old") }]);
    await storage.set(doc, [{ userId: "alice", wrappedKey: wrap("new") }]);

    expect((await storage.get(doc, "alice"))!.wrappedKey).toEqual(wrap("new"));
  });

  it("round-trips arbitrary wrapped key bytes", async () => {
    if (!available) return;
    const storage = makeStorage();
    const doc = docId();
    const wrappedKey = crypto.getRandomValues(new Uint8Array(64));
    await storage.set(doc, [{ userId: "alice", wrappedKey }]);
    expect((await storage.get(doc, "alice"))!.wrappedKey).toEqual(wrappedKey);
  });

  it("getAny returns an arbitrary entry", async () => {
    if (!available) return;
    const storage = makeStorage();
    const doc = docId();
    await storage.set(doc, [
      { userId: "alice", wrappedKey: wrap("key-a") },
      { userId: "bob", wrappedKey: wrap("key-b") },
    ]);

    const result = await storage.getAny(doc);
    expect(result).not.toBeNull();
    expect(["alice", "bob"]).toContain(result!.userId);
    expect(result!.generation).toBe(0);
  });

  it("revokes a user's key", async () => {
    if (!available) return;
    const storage = makeStorage();
    const doc = docId();
    await storage.set(doc, [
      { userId: "alice", wrappedKey: wrap("key-a") },
      { userId: "bob", wrappedKey: wrap("key-b") },
    ]);

    await storage.revoke(doc, ["alice"]);

    expect(await storage.get(doc, "alice")).toBeNull();
    expect(await storage.get(doc, "bob")).not.toBeNull();
  });

  it("returns meta with generation and sorted userIds", async () => {
    if (!available) return;
    const storage = makeStorage();
    const doc = docId();
    // Inserted out of order to check the ORDER BY.
    await storage.set(doc, [
      { userId: "bob", wrappedKey: wrap("key-b") },
      { userId: "alice", wrappedKey: wrap("key-a") },
    ]);

    const meta = await storage.getMeta(doc);
    expect(meta.generation).toBe(0);
    expect(meta.userIds).toEqual(["alice", "bob"]);
  });

  it("returns empty meta for unknown document", async () => {
    if (!available) return;
    const storage = makeStorage();
    const meta = await storage.getMeta(docId());
    expect(meta.generation).toBe(0);
    expect(meta.userIds).toEqual([]);
  });

  it("set and revoke leave the generation unchanged", async () => {
    if (!available) return;
    const storage = makeStorage();
    const doc = docId();
    await storage.set(doc, [{ userId: "alice", wrappedKey: wrap("v0") }]);
    await storage.rotate(doc, [{ userId: "alice", wrappedKey: wrap("v1") }], 0);

    expect(await storage.set(doc, [{ userId: "bob", wrappedKey: wrap("key-b") }])).toBe(1);
    expect(await storage.revoke(doc, ["bob"])).toBe(1);
    expect((await storage.getMeta(doc)).generation).toBe(1);
  });

  it("revoke on an unknown document returns generation 0", async () => {
    if (!available) return;
    const storage = makeStorage();
    expect(await storage.revoke(docId(), ["alice"])).toBe(0);
  });

  describe("rotate", () => {
    it("atomically replaces all keys and bumps generation", async () => {
      if (!available) return;
      const storage = makeStorage();
      const doc = docId();
      await storage.set(doc, [
        { userId: "alice", wrappedKey: wrap("old-a") },
        { userId: "bob", wrappedKey: wrap("old-b") },
      ]);

      const newGen = await storage.rotate(
        doc,
        [
          { userId: "alice", wrappedKey: wrap("new-a") },
          { userId: "charlie", wrappedKey: wrap("new-c") },
        ],
        0,
      );

      expect(newGen).toBe(1);
      expect((await storage.get(doc, "alice"))!.wrappedKey).toEqual(wrap("new-a"));
      expect((await storage.get(doc, "charlie"))!.wrappedKey).toEqual(wrap("new-c"));
      expect(await storage.get(doc, "bob")).toBeNull();
    });

    it("rejects rotation with wrong expectedGeneration using the exact conflict message", async () => {
      if (!available) return;
      const storage = makeStorage();
      const doc = docId();
      await storage.set(doc, [{ userId: "alice", wrappedKey: wrap("key") }]);

      const error = await storage
        .rotate(doc, [{ userId: "alice", wrappedKey: wrap("new") }], 99)
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(KeyRotationConflictError);
      expect((error as Error).name).toBe("KeyRotationConflictError");
      // Byte-identical to InMemoryKeyRegistryStorage's message.
      expect((error as Error).message).toBe(
        "Key rotation conflict: expected generation 99, but current is 0",
      );
    });

    it("leaves existing keys intact after a failed rotation", async () => {
      if (!available) return;
      const storage = makeStorage();
      const doc = docId();
      await storage.set(doc, [
        { userId: "alice", wrappedKey: wrap("key-a") },
        { userId: "bob", wrappedKey: wrap("key-b") },
      ]);

      await expect(
        storage.rotate(doc, [{ userId: "charlie", wrappedKey: wrap("new") }], 99),
      ).rejects.toThrow("Key rotation conflict");

      expect((await storage.get(doc, "alice"))!.wrappedKey).toEqual(wrap("key-a"));
      expect((await storage.get(doc, "bob"))!.wrappedKey).toEqual(wrap("key-b"));
      expect(await storage.get(doc, "charlie")).toBeNull();
      expect((await storage.getMeta(doc)).generation).toBe(0);
    });

    it("handles concurrent rotations — first wins", async () => {
      if (!available) return;
      const storage = makeStorage();
      const doc = docId();
      await storage.set(doc, [{ userId: "alice", wrappedKey: wrap("key") }]);

      await storage.rotate(doc, [{ userId: "alice", wrappedKey: wrap("v1") }], 0);

      await expect(
        storage.rotate(doc, [{ userId: "alice", wrappedKey: wrap("v2") }], 0),
      ).rejects.toThrow("Key rotation conflict");

      expect((await storage.get(doc, "alice"))!.wrappedKey).toEqual(wrap("v1"));
      expect((await storage.getMeta(doc)).generation).toBe(1);
    });

    it("supports successive rotations", async () => {
      if (!available) return;
      const storage = makeStorage();
      const doc = docId();
      await storage.set(doc, [{ userId: "alice", wrappedKey: wrap("v0") }]);

      await storage.rotate(doc, [{ userId: "alice", wrappedKey: wrap("v1") }], 0);
      await storage.rotate(doc, [{ userId: "alice", wrappedKey: wrap("v2") }], 1);
      await storage.rotate(doc, [{ userId: "alice", wrappedKey: wrap("v3") }], 2);

      expect((await storage.getMeta(doc)).generation).toBe(3);
      expect((await storage.get(doc, "alice"))!.wrappedKey).toEqual(wrap("v3"));
    });
  });

  describe("transaction", () => {
    it("serializes concurrent transactions on the same document", async () => {
      if (!available) return;
      const storage = makeStorage();
      const doc = docId();
      const order: number[] = [];
      await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          storage.transaction(doc, async () => {
            order.push(i);
            // Yield so overlapping transactions would interleave if unlocked.
            await new Promise((resolve) => setTimeout(resolve, 1));
            order.push(i);
          }),
        ),
      );
      // Each transaction's two entries must be adjacent (no interleaving).
      for (let i = 0; i < order.length; i += 2) {
        expect(order[i]).toBe(order[i + 1]);
      }
      await storage.close();
    });
  });
});
