import { describe, expect, it } from "bun:test";

import type { EncodedContentMap, PendingUpdate } from "teleportal/storage";

import { DurableObjectDocumentStorage } from "./document-storage";
import { FakeDOStorage } from "./fake-do-storage";
import { KeyedMutex } from "./types";

function makePending(tag: number): PendingUpdate {
  return {
    structureUpdate: new Uint8Array([tag, tag + 1, tag + 2]),
    sidecars: [],
  };
}

describe("DurableObjectDocumentStorage", () => {
  const make = (fake = new FakeDOStorage()) =>
    [new DurableObjectDocumentStorage(fake, { keyPrefix: "document" }), fake] as const;

  it("preserves pending-log order past single-digit sequence numbers", async () => {
    const [storage] = make();
    for (let i = 0; i < 12; i++) {
      await storage.appendUpdate("doc", makePending(i));
    }
    const { updates, cursor } = await storage.getPendingUpdates("doc");
    expect(cursor).toBe(12);
    expect(updates.map((u) => u.structureUpdate[0])).toEqual([...Array(12).keys()]);
  });

  it("clears only the consumed prefix of the pending log", async () => {
    const [storage] = make();
    for (let i = 0; i < 5; i++) {
      await storage.appendUpdate("doc", makePending(i));
    }
    const { cursor } = await storage.getPendingUpdates("doc");
    // Updates appended after the read survive the clear.
    await storage.appendUpdate("doc", makePending(100));
    await storage.appendUpdate("doc", makePending(101));

    await storage.clearPendingUpdates("doc", cursor);

    const { updates } = await storage.getPendingUpdates("doc");
    expect(updates.map((u) => u.structureUpdate[0])).toEqual([100, 101]);

    await storage.clearPendingUpdates("doc", Infinity);
    expect((await storage.getPendingUpdates("doc")).cursor).toBe(0);
  });

  it("continues the sequence after a restart (fresh instance, same storage)", async () => {
    const fake = new FakeDOStorage();
    const [first] = make(fake);
    for (let i = 0; i < 3; i++) {
      await first.appendUpdate("doc", makePending(i));
    }

    const [second] = make(fake);
    await second.appendUpdate("doc", makePending(3));

    const { updates } = await second.getPendingUpdates("doc");
    expect(updates.map((u) => u.structureUpdate[0])).toEqual([0, 1, 2, 3]);
  });

  it("round-trips base state bytes through structured clone", async () => {
    const [storage] = make();
    const update = new Uint8Array([1, 2, 3, 4, 5]);
    const sidecar = {
      encrypted: new Uint8Array([9, 9]) as never,
      index: [{ client: 1, clock: 0, len: 2 }] as never,
      hash: new Uint8Array([7]),
    };
    await storage.replaceBaseState("doc", update, [sidecar]);

    const state = await storage.getBaseState("doc");
    expect(state?.update).toEqual(update);
    expect(state?.sidecars).toHaveLength(1);
    expect(state?.sidecars[0].encrypted).toEqual(sidecar.encrypted);
    expect(state?.sidecars[0].hash).toEqual(sidecar.hash);

    expect(await storage.getBaseState("other")).toBeNull();
  });

  it("defaults and round-trips document metadata", async () => {
    const [storage] = make();
    const fresh = await storage.getDocumentMetadata("doc");
    expect(fresh.encrypted).toBe(true);
    expect(typeof fresh.createdAt).toBe("number");

    await storage.writeDocumentMetadata("doc", {
      createdAt: 1,
      updatedAt: 2,
      encrypted: false,
    });
    expect(await storage.getDocumentMetadata("doc")).toEqual({
      createdAt: 1,
      updatedAt: 2,
      encrypted: false,
    });
  });

  it("stores and retrieves attribution blobs", async () => {
    const [storage] = make();
    expect(await storage.retrieveAttribution("doc")).toBeNull();

    const blob = new Uint8Array([1, 2, 3]) as unknown as EncodedContentMap;
    await storage.storeAttribution("doc", blob);
    expect(await storage.retrieveAttribution("doc")).toEqual(blob);
  });

  it("deletes a document (batching past the 128-key bulk-delete cap) without touching neighbors", async () => {
    const fake = new FakeDOStorage();
    const [storage] = make(fake);
    for (let i = 0; i < 150; i++) {
      await storage.appendUpdate("doc", makePending(i % 200));
    }
    await storage.replaceBaseState("doc", new Uint8Array([1]), []);
    await storage.writeDocumentMetadata("doc", { createdAt: 1, updatedAt: 1, encrypted: true });
    await storage.replaceBaseState("doc-neighbor", new Uint8Array([2]), []);

    await storage.deleteDocument("doc");

    expect((await storage.getPendingUpdates("doc")).cursor).toBe(0);
    expect(await storage.getBaseState("doc")).toBeNull();
    expect((await storage.getBaseState("doc-neighbor"))?.update).toEqual(new Uint8Array([2]));
    expect(fake.size).toBe(1);
  });

  it("paginates pending reads past one list() page", async () => {
    const [storage] = make();
    const total = 1050; // LIST_PAGE_SIZE is 1000
    for (let i = 0; i < total; i++) {
      await storage.appendUpdate("doc", makePending(i % 200));
    }
    const { updates, cursor } = await storage.getPendingUpdates("doc");
    expect(cursor).toBe(total);
    expect(updates[0].structureUpdate[0]).toBe(0);
    expect(updates[total - 1].structureUpdate[0]).toBe((total - 1) % 200);
  });

  it("serializes transactions per key", async () => {
    const [storage] = make();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = storage.transaction("doc", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = storage.transaction("doc", async () => {
      order.push("second");
    });

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});

describe("KeyedMutex", () => {
  it("keeps the chain alive after a rejected callback", async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(mutex.run("k", async () => "ok")).resolves.toBe("ok");
  });
});
