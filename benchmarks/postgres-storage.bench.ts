/**
 * Postgres storage adapter benchmarks. Requires a reachable Postgres
 * (docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17-alpine);
 * skips cleanly otherwise. Run via `bun run bench:postgres`.
 *
 * Design claims validated here:
 * - appendUpdate is O(1): latency stays flat as the pending log deepens
 * - handleSyncStep1 cost tracks pending-log depth (merge-on-read)
 * - transaction() advisory-lock overhead is a small constant, contended or not
 * - UNLOGGED rate-limit upserts are cheap enough for per-message use
 *
 * Baseline (2026-07, M-series laptop, dockerized postgres:17-alpine):
 *   codec round trip                 ~0.3μs   (3.3M ops/s)
 *   appendUpdate p50                 ~0.7ms   (flat: depth-1000/depth-0 ratio 0.92x)
 *   handleUpdate (lock+append+meta)  ~1.8ms p50
 *   handleSyncStep1 p50              0 pending ~0.33ms / 50 ~0.53ms / 500 ~5.5ms
 *   transaction no-op p50            ~154μs uncontended, ~1.2ms under 8-way contention
 *   rateLimit set/get p50            ~105μs   (~9.4K ops/s)
 *   keyRegistry rotate (4 users)     ~1.6ms p50
 */

import { afterAll, beforeAll, describe, it } from "bun:test";
import * as Y from "yjs";

import type { VersionedUpdate, Update } from "teleportal";
import { encodeContentEncryptedPayload } from "../src/lib/protocol/encryption/encoding";
import type { PendingUpdate } from "../src/storage/document-storage";
import { MemoryDocumentStorage } from "../src/storage/in-memory/document-storage";
import { PostgresDocumentStorage } from "../src/storage/postgres/document-storage";
import { PostgresKeyRegistryStorage } from "../src/storage/postgres/key-registry-storage";
import { PostgresRateLimitStorage } from "../src/storage/postgres/rate-limit-storage";
import { decodePendingUpdate, encodePendingUpdate } from "../src/storage/postgres/codec";
import { dropSchema, ensureSchema } from "../src/storage/postgres/schema";
import {
  isPostgresAvailable,
  makeTestSql,
  randomTablePrefix,
} from "../src/storage/postgres/test-utils";
import type { Sql } from "../src/storage/postgres/types";
import { bench } from "./helpers";

let available = false;
let sql: (Sql & { end(): Promise<void> }) | undefined;
const prefix = randomTablePrefix();
const closeables: { close(): Promise<void> }[] = [];

function makeStorage(): PostgresDocumentStorage {
  const storage = new PostgresDocumentStorage(sql!, { tablePrefix: prefix, encrypted: false });
  closeables.push(storage);
  return storage;
}

function wrapUpdate(rawV2: Uint8Array): VersionedUpdate {
  const payload = encodeContentEncryptedPayload({
    structureUpdate: rawV2,
    encryptedSidecars: [],
  });
  return { version: 2, data: payload as Update } as VersionedUpdate;
}

function makeUpdate(content: string): VersionedUpdate {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  return wrapUpdate(Y.encodeStateAsUpdateV2(doc));
}

function makeEntry(content: string): PendingUpdate {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  return { structureUpdate: Y.encodeStateAsUpdateV2(doc), sidecars: [] };
}

async function seedPending(storage: PostgresDocumentStorage, key: string, count: number) {
  for (let i = 0; i < count; i++) {
    await storage.appendUpdate(key, makeEntry(`seed-${i}`));
  }
}

beforeAll(async () => {
  available = await isPostgresAvailable();
  if (!available) {
    console.log("Skipping Postgres benchmarks - Postgres not available");
    return;
  }
  sql = makeTestSql(10);
  await ensureSchema(sql, { tablePrefix: prefix });
});

afterAll(async () => {
  for (const closeable of closeables) {
    await closeable.close();
  }
  if (sql) {
    await dropSchema(sql, { tablePrefix: prefix });
    await sql.end();
  }
});

describe("Postgres Storage Benchmarks", () => {
  it("codec encode/decode round trip", async () => {
    const entry = makeEntry("codec-bench-content");
    await bench("codec: encodePendingUpdate+decode", () => {
      decodePendingUpdate(encodePendingUpdate(entry));
    });
  });

  it("appendUpdate stays O(1) as the pending log deepens", async () => {
    if (!available) return;
    const storage = makeStorage();
    const entry = makeEntry("append-bench");

    const shallow = "bench-append-shallow";
    const deep = "bench-append-deep";
    await seedPending(storage, deep, 1000);

    const flat = await bench("appendUpdate (0 pending)", () =>
      storage.appendUpdate(shallow, entry));
    const loaded = await bench("appendUpdate (1000+ pending)", () =>
      storage.appendUpdate(deep, entry));
    console.log(
      `  → depth 1000 vs 0 latency ratio: ${(loaded.p50Ms / flat.p50Ms).toFixed(2)}x (≈1 proves O(1))`,
    );
  });

  it("handleUpdate full path vs in-memory ceiling", async () => {
    if (!available) return;
    const storage = makeStorage();
    const update = makeUpdate("handle-update-bench");

    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    const memory = new MemoryDocumentStorage(false);

    await bench("handleUpdate (postgres: lock+append+metadata)", () =>
      storage.handleUpdate("bench-handle-update", update));
    await bench("handleUpdate (in-memory ceiling)", () =>
      memory.handleUpdate("bench-handle-update", update));
  });

  it("handleSyncStep1 across pending-log depths", async () => {
    if (!available) return;
    const storage = makeStorage();
    const emptySV = Y.encodeStateVector(new Y.Doc()) as Parameters<
      typeof storage.handleSyncStep1
    >[1];

    for (const depth of [0, 50, 500]) {
      const key = `bench-sync-${depth}`;
      await storage.handleUpdate(key, makeUpdate("base"));
      await seedPending(storage, key, depth);
      await bench(`handleSyncStep1 (${depth} pending)`, () =>
        storage.handleSyncStep1(key, emptySV));
    }
  });

  it("transaction() lock overhead", async () => {
    if (!available) return;
    const storage = makeStorage();

    await bench("transaction (uncontended no-op)", () =>
      storage.transaction("bench-tx", async () => {}));
    await bench("transaction (8-way same-key contention)", () =>
      Promise.all(
        Array.from({ length: 8 }, () => storage.transaction("bench-tx-hot", async () => {})),
      ));
  });

  it("rate limit get+set on the UNLOGGED table", async () => {
    if (!available) return;
    const rateLimits = new PostgresRateLimitStorage(sql!, { tablePrefix: prefix });
    closeables.push(rateLimits);
    const state = { tokens: 10, lastRefill: Date.now(), windowMs: 1000, maxMessages: 100 };

    await bench("rateLimit setState (upsert)", () =>
      rateLimits.setState("bench-rl", state, 60_000));
    await bench("rateLimit getState", () => rateLimits.getState("bench-rl"));
  });

  it("key registry rotate", async () => {
    if (!available) return;
    const keys = new PostgresKeyRegistryStorage(sql!, { tablePrefix: prefix });
    closeables.push(keys);
    const entries = Array.from({ length: 4 }, (_, i) => ({
      userId: `user-${i}`,
      wrappedKey: new Uint8Array(40).fill(i),
    }));

    let generation = 0;
    await bench("keyRegistry rotate (4 users)", async () => {
      generation = await keys.rotate("bench-doc", entries, generation);
    });
  });
});
