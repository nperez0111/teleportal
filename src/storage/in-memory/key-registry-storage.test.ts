import { describe, expect, it } from "bun:test";
import { InMemoryKeyRegistryStorage } from "./key-registry-storage";

function wrap(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("InMemoryKeyRegistryStorage", () => {
  it("should return null for unknown document/user", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    expect(await storage.get("doc-1", "alice")).toBeNull();
    expect(await storage.getAny("doc-1")).toBeNull();
  });

  it("should set and get a wrapped key", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("key-a") }]);

    const result = await storage.get("doc-1", "alice");
    expect(result).not.toBeNull();
    expect(result!.wrappedKey).toEqual(wrap("key-a"));
    expect(result!.generation).toBe(0);
  });

  it("should set multiple entries at once", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    await storage.set("doc-1", [
      { userId: "alice", wrappedKey: wrap("key-a") },
      { userId: "bob", wrappedKey: wrap("key-b") },
    ]);

    expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("key-a"));
    expect((await storage.get("doc-1", "bob"))!.wrappedKey).toEqual(wrap("key-b"));
  });

  it("should upsert on repeated set", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("old") }]);
    await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("new") }]);

    expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("new"));
  });

  it("should getAny return an arbitrary entry", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    await storage.set("doc-1", [
      { userId: "alice", wrappedKey: wrap("key-a") },
      { userId: "bob", wrappedKey: wrap("key-b") },
    ]);

    const result = await storage.getAny("doc-1");
    expect(result).not.toBeNull();
    expect(["alice", "bob"]).toContain(result!.userId);
  });

  it("should revoke a user's key", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    await storage.set("doc-1", [
      { userId: "alice", wrappedKey: wrap("key-a") },
      { userId: "bob", wrappedKey: wrap("key-b") },
    ]);

    await storage.revoke("doc-1", ["alice"]);

    expect(await storage.get("doc-1", "alice")).toBeNull();
    expect(await storage.get("doc-1", "bob")).not.toBeNull();
  });

  it("should return meta with generation and userIds", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    await storage.set("doc-1", [
      { userId: "alice", wrappedKey: wrap("key-a") },
      { userId: "bob", wrappedKey: wrap("key-b") },
    ]);

    const meta = await storage.getMeta("doc-1");
    expect(meta.generation).toBe(0);
    expect(meta.userIds.sort()).toEqual(["alice", "bob"]);
  });

  it("should return empty meta for unknown document", async () => {
    const storage = new InMemoryKeyRegistryStorage();
    const meta = await storage.getMeta("unknown");
    expect(meta.generation).toBe(0);
    expect(meta.userIds).toEqual([]);
  });

  describe("rotate", () => {
    it("should atomically replace all keys and bump generation", async () => {
      const storage = new InMemoryKeyRegistryStorage();
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
      const storage = new InMemoryKeyRegistryStorage();
      await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("key") }]);

      await expect(
        storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("new") }], 99),
      ).rejects.toThrow("Key rotation conflict");
    });

    it("should handle concurrent rotations — first wins", async () => {
      const storage = new InMemoryKeyRegistryStorage();
      await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("key") }]);

      await storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("v1") }], 0);

      await expect(
        storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("v2") }], 0),
      ).rejects.toThrow("Key rotation conflict");

      expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("v1"));
      expect((await storage.getMeta("doc-1")).generation).toBe(1);
    });

    it("should support successive rotations", async () => {
      const storage = new InMemoryKeyRegistryStorage();
      await storage.set("doc-1", [{ userId: "alice", wrappedKey: wrap("v0") }]);

      await storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("v1") }], 0);
      await storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("v2") }], 1);
      await storage.rotate("doc-1", [{ userId: "alice", wrappedKey: wrap("v3") }], 2);

      expect((await storage.getMeta("doc-1")).generation).toBe(3);
      expect((await storage.get("doc-1", "alice"))!.wrappedKey).toEqual(wrap("v3"));
    });
  });
});
