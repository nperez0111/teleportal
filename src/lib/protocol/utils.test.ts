import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import type { UpdateV1, UpdateV2, VersionedUpdate } from "teleportal/protocol";
import { mergeVersionedUpdates, applyVersionedUpdate, isEmptyVersionedUpdate } from "./utils";

function makeV1Update(key: string, value: string): VersionedUpdate {
  const doc = new Y.Doc();
  doc.getMap("test").set(key, value);
  return { version: 1, data: Y.encodeStateAsUpdate(doc) as UpdateV1 };
}

function makeV2Update(key: string, value: string): VersionedUpdate {
  const doc = new Y.Doc();
  doc.getMap("test").set(key, value);
  return { version: 2, data: Y.encodeStateAsUpdateV2(doc) as UpdateV2 };
}

function applyAndRead(merged: VersionedUpdate): Map<string, string> {
  const doc = new Y.Doc();
  applyVersionedUpdate(doc, merged);
  return doc.getMap<string>("test").toJSON() as unknown as Map<string, string>;
}

describe("mergeVersionedUpdates", () => {
  it("returns empty update for empty array", () => {
    const result = mergeVersionedUpdates([]);
    expect(result.version).toBe(2);
    expect(isEmptyVersionedUpdate(result)).toBe(true);
  });

  it("merges multiple V1 updates as V1", () => {
    const a = makeV1Update("a", "1");
    const b = makeV1Update("b", "2");

    const merged = mergeVersionedUpdates([a, b]);
    expect(merged.version).toBe(1);

    const result = applyAndRead(merged);
    expect(result).toMatchObject({ a: "1", b: "2" });
  });

  it("merges multiple V2 updates as V2", () => {
    const a = makeV2Update("a", "1");
    const b = makeV2Update("b", "2");

    const merged = mergeVersionedUpdates([a, b]);
    expect(merged.version).toBe(2);

    const result = applyAndRead(merged);
    expect(result).toMatchObject({ a: "1", b: "2" });
  });

  it("merges mixed V1 and V2 updates without throwing", () => {
    const v1 = makeV1Update("a", "1");
    const v2 = makeV2Update("b", "2");

    const merged = mergeVersionedUpdates([v1, v2]);
    expect(merged.version).toBe(2);

    const result = applyAndRead(merged);
    expect(result).toMatchObject({ a: "1", b: "2" });
  });

  it("merges mixed V2-first then V1 updates", () => {
    const v2 = makeV2Update("x", "10");
    const v1 = makeV1Update("y", "20");

    const merged = mergeVersionedUpdates([v2, v1]);
    expect(merged.version).toBe(2);

    const result = applyAndRead(merged);
    expect(result).toMatchObject({ x: "10", y: "20" });
  });

  it("handles single V1 update", () => {
    const v1 = makeV1Update("solo", "val");

    const merged = mergeVersionedUpdates([v1]);
    expect(merged.version).toBe(1);

    const result = applyAndRead(merged);
    expect(result).toMatchObject({ solo: "val" });
  });

  it("handles single V2 update", () => {
    const v2 = makeV2Update("solo", "val");

    const merged = mergeVersionedUpdates([v2]);
    expect(merged.version).toBe(2);

    const result = applyAndRead(merged);
    expect(result).toMatchObject({ solo: "val" });
  });

  it("merges many mixed updates in a burst", () => {
    const updates: VersionedUpdate[] = [];
    for (let i = 0; i < 10; i++) {
      const make = i % 3 === 0 ? makeV2Update : makeV1Update;
      updates.push(make(`key${i}`, `val${i}`));
    }

    const merged = mergeVersionedUpdates(updates);
    expect(merged.version).toBe(2);

    const result = applyAndRead(merged);
    for (let i = 0; i < 10; i++) {
      expect(result).toHaveProperty(`key${i}`, `val${i}`);
    }
  });
});
