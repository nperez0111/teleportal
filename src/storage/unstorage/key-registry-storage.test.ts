import { beforeEach, describe, expect, it } from "bun:test";
import { createStorage } from "unstorage";
import { UnstorageKeyRegistryStorage } from "./key-registry-storage";

function wrap(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("UnstorageKeyRegistryStorage", () => {
  let storage: UnstorageKeyRegistryStorage;

  beforeEach(() => {
    const unstorage = createStorage();
    storage = new UnstorageKeyRegistryStorage(
      unstorage,
      { keyPrefix: "keys" },
      { ttl: 5000, baseDelay: 1 },
    );
  });

  it("should return null for unknown document/user", async () => {
    expect(await storage.get("doc-1", "alice")).toBeNull();
    expect(await storage.getAny("doc-1")).toBeNull();
  });

  it("should set and get a wrapped key", async () => {
    await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("key-a") }]);

    const result = await storage.get("doc-1", "alice");
    expect(result).not.toBeNull();
    expect(result!.wrappedKey).toEqual(wrap("key-a"));
    expect(result!.generation).toBe(0);
  });

  it("should set multiple entries at once", async () => {
    await storage.set("doc-1", [
      { userId: "alice", wrappedKey: wrap("key-a") },
      { userId: "bob", wrappedKey: wrap("key-b") },
    ]);

    expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("key-a"));
    expect((await storage.get("doc-1", "bob"))!.wrappedKey).toEqual(wrap("key-b"));
  });

  it("should upsert on repeated set", async () => {
    await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("old") }]);
    await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("new") }]);

    expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("new"));
  });

  it("should getAny return an arbitrary entry", async () => {
    await storage.set("doc-1", [
      { userId: "alice", wrappedKey: wrap("key-a") },
      { userId: "bob", wrappedKey: wrap("key-b") },
    ]);

    const result = await storage.getAny("doc-1");
    expect(result).not.toBeNull();
    expect(["alice", "bob"]).toContain(result!.userId);
  });

  it("should revoke a user's key", async () => {
    await storage.set("doc-1", [
      { userId: "alice", wrappedKey: wrap("key-a") },
      { userId: "bob", wrappedKey: wrap("key-b") },
    ]);

    await storage.revoke("doc-1", ["alice"]);

    expect(await storage.get("doc-1", "alice")).toBeNull();
    expect(await storage.get("doc-1", "bob")).not.toBeNull();
  });

  it("should return meta with generation and userIds", async () => {
    await storage.set("doc-1", [
      { userId: "alice", wrappedKey: wrap("key-a") },
      { userId: "bob", wrappedKey: wrap("key-b") },
    ]);

    const meta = await storage.getMeta("doc-1");
    expect(meta.generation).toBe(0);
    expect(meta.userIds.sort()).toEqual(["alice", "bob"]);
  });

  it("should return empty meta for unknown document", async () => {
    const meta = await storage.getMeta("unknown");
    expect(meta.generation).toBe(0);
    expect(meta.userIds).toEqual([]);
  });

  it("should isolate documents from each other", async () => {
    await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("key-1") }]);
    await storage.set("doc-2", [{ userId: "alice", wrappedKey: wrap("key-2") }]);

    expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("key-1"));
    expect((await storage.get("doc-2", "alice"))!.wrappedKey).toEqual(wrap("key-2"));
  });

  it("should use default keyPrefix when none provided", async () => {
    const unstorage = createStorage();
    const s = new UnstorageKeyRegistryStorage(unstorage);
    await s.set("doc-1", [{ userId: "alice", wrappedKey: wrap("key-a") }]);
    expect((await s.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("key-a"));
  });

  describe("rotate", () => {
    it("should atomically replace all keys and bump generation", async () => {
      await storage.set("doc-1", [
        { userId: "alice", wrappedKey: wrap("old-a") },
        { userId: "bob", wrappedKey: wrap("old-b") },
      ]);

      const newGen = await storage.rotate(
        "doc-1",
        [
          { userId: "alice", wrappedKey: wrap("new-a") },
          { userId: "charlie", wrappedKey: wrap("new-c") },
        ],
        0,
      );

      expect(newGen).toBe(1);
      expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("new-a"));
      expect((await storage.get("doc-1", "charlie"))!.wrappedKey).toEqual(wrap("new-c"));
      expect(await storage.get("doc-1", "bob")).toBeNull();
    });

    it("should reject rotation with wrong expectedGeneration", async () => {
      await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("key") }]);

      await expect(
        storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("new") }], 99),
      ).rejects.toThrow("Key rotation conflict");
    });

    it("should handle concurrent rotations — first wins", async () => {
      await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("key") }]);

      await storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("v1") }], 0);

      await expect(
        storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("v2") }], 0),
      ).rejects.toThrow("Key rotation conflict");

      expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("v1"));
      expect((await storage.getMeta("doc-1")).generation).toBe(1);
    });

    it("should support successive rotations", async () => {
      await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("v0") }]);

      await storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("v1") }], 0);
      await storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("v2") }], 1);
      await storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("v3") }], 2);

      expect((await storage.getMeta("doc-1")).generation).toBe(3);
      expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("v3"));
    });
  });

  describe("transaction", () => {
    it("should execute callback and return its result", async () => {
      const result = await storage.transaction("doc-1", async () => {
        await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("key-a") }]);
        return "done";
      });

      expect(result).toBe("done");
      expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("key-a"));
    });

    it("should serialize concurrent transactions on the same document", async () => {
      await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("v0") }]);
      const order: string[] = [];

      const p1 = storage.transaction("doc-1", async () => {
        order.push("start-1");
        await new Promise((resolve) => setTimeout(resolve, 5));
        await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("v1") }]);
        order.push("end-1");
      });

      const p2 = storage.transaction("doc-1", async () => {
        order.push("start-2");
        await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("v2") }]);
        order.push("end-2");
      });

      await Promise.all([p1, p2]);

      expect(order.length).toBe(4);
      if (order[0] === "start-1") {
        expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
      } else {
        expect(order).toEqual(["start-2", "end-2", "start-1", "end-1"]);
      }
    });

    it("should allow concurrent transactions on different documents", async () => {
      const order: string[] = [];

      const p1 = storage.transaction("doc-1", async () => {
        order.push("start-1");
        await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("key-1") }]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("end-1");
      });

      const p2 = storage.transaction("doc-2", async () => {
        order.push("start-2");
        await storage.set("doc-2", [{ userId: "bob", wrappedKey: wrap("key-2") }]);
        order.push("end-2");
      });

      await Promise.all([p1, p2]);

      expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("key-1"));
      expect((await storage.get("doc-2", "bob"))!.wrappedKey).toEqual(wrap("key-2"));
    });
  });

  describe("persistence", () => {
    it("should persist keys across reads from the same storage", async () => {
      const unstorage = createStorage();
      const s1 = new UnstorageKeyRegistryStorage(unstorage, { keyPrefix: "keys" });
      await s1.set("doc-1", [{ userId: "alice", wrappedKey: wrap("persisted") }]);

      const s2 = new UnstorageKeyRegistryStorage(unstorage, { keyPrefix: "keys" });
      const result = await s2.get("doc-1", "alice");
      expect(result).not.toBeNull();
      expect(result!.wrappedKey).toEqual(wrap("persisted"));
    });

    it("should persist generation across storage instances", async () => {
      const unstorage = createStorage();
      const s1 = new UnstorageKeyRegistryStorage(unstorage, { keyPrefix: "keys" });
      await s1.set("doc-1", [{ userId: "alice", wrappedKey: wrap("v0") }]);
      await s1.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("v1") }], 0);

      const s2 = new UnstorageKeyRegistryStorage(unstorage, { keyPrefix: "keys" });
      const meta = await s2.getMeta("doc-1");
      expect(meta.generation).toBe(1);
    });
  });
});
