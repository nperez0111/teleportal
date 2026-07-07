import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as Y from "yjs";

import { encodeContentMap, decodeContentMap, createContentMap } from "teleportal/attribution";
import type { EncodedContentMap } from "../types";
import type { PendingUpdate } from "../document-storage";
import { PostgresDocumentStorage } from "./document-storage";
import { LockTimeoutError } from "./lock";
import { dropSchema, ensureSchema } from "./schema";
import { isPostgresAvailable, makeTestSql, randomTablePrefix } from "./test-utils";
import type { Sql } from "./types";

let available = false;
let sql: (Sql & { end(): Promise<void> }) | undefined;
const prefix = randomTablePrefix();
const storages: PostgresDocumentStorage[] = [];

function makeStorage(options?: { encrypted?: boolean; lockTimeoutMs?: number }) {
  const storage = new PostgresDocumentStorage(sql!, { tablePrefix: prefix, ...options });
  storages.push(storage);
  return storage;
}

function makeEntry(text: string): PendingUpdate {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, text);
  return {
    structureUpdate: Y.encodeStateAsUpdateV2(doc),
    sidecars: [],
  };
}

function makeAttribution(): EncodedContentMap {
  return encodeContentMap(createContentMap());
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

describe("PostgresDocumentStorage", () => {
  describe("pending log", () => {
    it("appends and reads back pending updates in order", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      const entries = [makeEntry("a"), makeEntry("b"), makeEntry("c")];
      for (const entry of entries) {
        await storage.appendUpdate(key, entry);
      }
      const { updates, cursor } = await storage.getPendingUpdates(key);
      expect(updates.map((u) => u.structureUpdate)).toEqual(entries.map((e) => e.structureUpdate));
      expect(cursor).toBeGreaterThan(0);
    });

    it("returns cursor 0 and no updates for an unknown document", async () => {
      if (!available) return;
      const storage = makeStorage();
      const result = await storage.getPendingUpdates(`doc-${crypto.randomUUID()}`);
      expect(result).toEqual({ updates: [], cursor: 0 });
    });

    it("clears only entries up to the cursor, keeping concurrent appends", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      await storage.appendUpdate(key, makeEntry("a"));
      await storage.appendUpdate(key, makeEntry("b"));
      const { cursor } = await storage.getPendingUpdates(key);
      // Simulates an append racing in after the read.
      const late = makeEntry("late");
      await storage.appendUpdate(key, late);
      await storage.clearPendingUpdates(key, cursor);
      const { updates } = await storage.getPendingUpdates(key);
      expect(updates).toHaveLength(1);
      expect(updates[0].structureUpdate).toEqual(late.structureUpdate);
    });

    it("clears everything for Infinity and nothing for cursor <= 0", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      await storage.appendUpdate(key, makeEntry("a"));
      await storage.clearPendingUpdates(key, 0);
      expect((await storage.getPendingUpdates(key)).updates).toHaveLength(1);
      await storage.clearPendingUpdates(key, Infinity);
      expect((await storage.getPendingUpdates(key)).updates).toHaveLength(0);
    });

    it("does not leak pending updates across documents", async () => {
      if (!available) return;
      const storage = makeStorage();
      const a = `doc-${crypto.randomUUID()}`;
      const b = `doc-${crypto.randomUUID()}`;
      await storage.appendUpdate(a, makeEntry("a"));
      await storage.clearPendingUpdates(b, Infinity);
      expect((await storage.getPendingUpdates(a)).updates).toHaveLength(1);
      expect((await storage.getPendingUpdates(b)).updates).toHaveLength(0);
    });
  });

  describe("base state", () => {
    it("returns null for unknown documents", async () => {
      if (!available) return;
      const storage = makeStorage();
      expect(await storage.getBaseState(`doc-${crypto.randomUUID()}`)).toBeNull();
    });

    it("round-trips base state with sidecars", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      const entry = makeEntry("base");
      const sidecars = [
        {
          encrypted: new Uint8Array([1, 2, 3]) as PendingUpdate["sidecars"][0]["encrypted"],
          index: [{ clientId: 7, minClock: 0, maxClock: 3 }],
          hash: new Uint8Array(32).fill(9),
        },
      ];
      await storage.replaceBaseState(key, entry.structureUpdate, sidecars);
      const state = await storage.getBaseState(key);
      expect(state?.update).toEqual(entry.structureUpdate);
      expect(state?.sidecars).toEqual(sidecars);
    });

    it("overwrites base state on replace and preserves metadata", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      await storage.writeDocumentMetadata(key, {
        createdAt: 111,
        updatedAt: 222,
        encrypted: true,
      });
      await storage.replaceBaseState(key, makeEntry("v1").structureUpdate, []);
      const next = makeEntry("v2");
      await storage.replaceBaseState(key, next.structureUpdate, []);
      expect((await storage.getBaseState(key))?.update).toEqual(next.structureUpdate);
      const metadata = await storage.getDocumentMetadata(key);
      expect(metadata.createdAt).toBe(111);
      expect(metadata.updatedAt).toBe(222);
    });

    it("returns null base state when only metadata exists", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      await storage.writeDocumentMetadata(key, { createdAt: 1, updatedAt: 1, encrypted: true });
      expect(await storage.getBaseState(key)).toBeNull();
    });
  });

  describe("metadata", () => {
    it("returns normalized defaults for unknown documents", async () => {
      if (!available) return;
      const storage = makeStorage();
      const before = Date.now();
      const metadata = await storage.getDocumentMetadata(`doc-${crypto.randomUUID()}`);
      expect(metadata.createdAt).toBeGreaterThanOrEqual(before);
      expect(metadata.updatedAt).toBeGreaterThanOrEqual(before);
      expect(metadata.encrypted).toBe(true);
    });

    it("respects the encrypted flag of the storage", async () => {
      if (!available) return;
      const storage = makeStorage({ encrypted: false });
      const metadata = await storage.getDocumentMetadata(`doc-${crypto.randomUUID()}`);
      expect(metadata.encrypted).toBe(false);
    });

    it("round-trips metadata including custom fields", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      await storage.writeDocumentMetadata(key, {
        createdAt: 5,
        updatedAt: 6,
        encrypted: true,
        milestones: ["m1", "m2"],
      });
      const metadata = await storage.getDocumentMetadata(key);
      expect(metadata.createdAt).toBe(5);
      expect(metadata.updatedAt).toBe(6);
      expect(metadata.milestones).toEqual(["m1", "m2"]);
    });
  });

  describe("deleteDocument", () => {
    it("removes state, pending updates, metadata, and attribution", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      await storage.replaceBaseState(key, makeEntry("x").structureUpdate, []);
      await storage.appendUpdate(key, makeEntry("y"));
      await storage.writeDocumentMetadata(key, { createdAt: 1, updatedAt: 1, encrypted: true });
      await storage.storeAttribution(key, makeAttribution());
      await storage.deleteDocument(key);
      expect(await storage.getBaseState(key)).toBeNull();
      expect((await storage.getPendingUpdates(key)).updates).toHaveLength(0);
      expect(await storage.retrieveAttribution(key)).toBeNull();
    });
  });

  describe("transaction", () => {
    it("serializes concurrent transactions on the same key", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      const order: number[] = [];
      await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          storage.transaction(key, async () => {
            order.push(i);
            await storage.appendUpdate(key, makeEntry(`t${i}`));
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
      expect((await storage.getPendingUpdates(key)).updates).toHaveLength(4);
      await storage.close();
    });

    it("allows different keys to proceed concurrently", async () => {
      if (!available) return;
      const storage = makeStorage();
      let signalAInside!: () => void;
      const aInside = new Promise<void>((resolve) => {
        signalAInside = resolve;
      });
      let signalBDone!: () => void;
      const bDone = new Promise<void>((resolve) => {
        signalBDone = resolve;
      });
      // A holds its key's lock until B completes; if the two keys shared a
      // lock this would deadlock (and time out) instead of completing.
      await Promise.all([
        storage.transaction(`doc-a-${crypto.randomUUID()}`, async () => {
          signalAInside();
          await bDone;
        }),
        (async () => {
          await aInside;
          await storage.transaction(`doc-b-${crypto.randomUUID()}`, async () => {});
          signalBDone();
        })(),
      ]);
      await storage.close();
    });

    it("releases the lock when the callback throws", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      await expect(
        storage.transaction(key, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      // A follow-up transaction must not deadlock.
      const result = await storage.transaction(key, async () => "ok");
      expect(result).toBe("ok");
      await storage.close();
    });

    it("blocks cross-instance access and times out on a wedged holder", async () => {
      if (!available) return;
      const holder = makeStorage();
      const waiter = makeStorage({ lockTimeoutMs: 50 });
      const key = `doc-${crypto.randomUUID()}`;
      let releaseHolder!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let signalAcquired!: () => void;
      const acquired = new Promise<void>((resolve) => {
        signalAcquired = resolve;
      });
      const holding = holder.transaction(key, async () => {
        signalAcquired();
        await held;
      });
      // The callback only runs once the advisory lock is held.
      await acquired;
      await expect(waiter.transaction(key, async () => "never")).rejects.toThrow(LockTimeoutError);
      releaseHolder();
      await holding;
      // After release, the waiter instance works again.
      expect(await waiter.transaction(key, async () => "ok")).toBe("ok");
      await holder.close();
      await waiter.close();
    });
  });

  describe("attribution", () => {
    it("returns null when nothing was stored", async () => {
      if (!available) return;
      const storage = makeStorage();
      expect(await storage.retrieveAttribution(`doc-${crypto.randomUUID()}`)).toBeNull();
    });

    it("stores and retrieves a single attribution blob unchanged", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      const attribution = makeAttribution();
      await storage.storeAttribution(key, attribution);
      const retrieved = await storage.retrieveAttribution(key);
      expect(retrieved).toEqual(attribution);
    });

    it("merges multiple blobs on read", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      await storage.storeAttribution(key, makeAttribution());
      await storage.storeAttribution(key, makeAttribution());
      const retrieved = await storage.retrieveAttribution(key);
      expect(retrieved).not.toBeNull();
      expect(() => decodeContentMap(retrieved!)).not.toThrow();
    });

    it("compacts to a single row once the threshold is reached", async () => {
      if (!available) return;
      const storage = makeStorage();
      const key = `doc-${crypto.randomUUID()}`;
      const threshold = PostgresDocumentStorage.ATTRIBUTION_COMPACTION_THRESHOLD;
      for (let i = 0; i < threshold; i++) {
        await storage.storeAttribution(key, makeAttribution());
      }
      const rows = (await sql!.unsafe(
        `SELECT count(*)::int AS count FROM ${prefix}attributions WHERE document_id = '${key}'`,
      )) as { count: number }[];
      expect(Number(rows[0].count)).toBe(1);
      expect(await storage.retrieveAttribution(key)).not.toBeNull();
    });
  });

  describe("end-to-end via AbstractDocumentStorage", () => {
    it("materializes pending updates into the document state", async () => {
      if (!available) return;
      const storage = makeStorage({ encrypted: false });
      const key = `doc-${crypto.randomUUID()}`;
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "hello");
      await storage.appendUpdate(key, {
        structureUpdate: Y.encodeStateAsUpdateV2(doc),
        sidecars: [],
      });
      doc.getText("t").insert(5, " world");
      const sv = Y.encodeStateVector(doc);
      void sv;
      const state = await storage.getDocumentState(key);
      expect(state).not.toBeNull();
      const materialized = new Y.Doc();
      Y.applyUpdateV2(materialized, state!.update);
      expect(materialized.getText("t").toString()).toBe("hello");
    });
  });
});
