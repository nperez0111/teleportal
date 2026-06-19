import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import type { UpdateV2 } from "teleportal";
import {
  IdMap,
  IdSet,
  createContentAttribute,
  createContentIds,
  createContentIdsFromUpdate,
  createContentMapFromContentIds,
  decodeContentIds,
  decodeContentMap,
  encodeContentIds,
  encodeContentMap,
  excludeContentIds,
  excludeContentMap,
  filterContentMap,
  getActivity,
  intersectContentIds,
  mergeContentIds,
  mergeContentMaps,
  resolveItemAttribution,
} from "./index";

describe("IdSet", () => {
  it("adds and retrieves ranges", () => {
    const set = new IdSet();
    set.add(1, 0, 5);
    set.add(1, 5, 3);
    set.add(2, 0, 10);

    expect(set.has(1, 0)).toBe(true);
    expect(set.has(1, 4)).toBe(true);
    expect(set.has(1, 7)).toBe(true);
    expect(set.has(1, 8)).toBe(false);
    expect(set.has(2, 9)).toBe(true);
    expect(set.has(3, 0)).toBe(false);
  });

  it("merges adjacent ranges from same client", () => {
    const set = new IdSet();
    set.add(1, 0, 5);
    set.add(1, 5, 5);

    const ranges = set.clients.get(1)!.getIds();
    expect(ranges.length).toBe(1);
    expect(ranges[0].clock).toBe(0);
    expect(ranges[0].len).toBe(10);
  });

  it("slices correctly", () => {
    const set = new IdSet();
    set.add(1, 5, 10); // clock 5-14

    const slices = set.slice(1, 3, 15);
    expect(slices.length).toBe(3);
    expect(slices[0]).toEqual({ clock: 3, len: 2, exists: false });
    expect(slices[1]).toEqual({ clock: 5, len: 10, exists: true });
    expect(slices[2]).toEqual({ clock: 15, len: 3, exists: false });
  });

  it("handles delete", () => {
    const set = new IdSet();
    set.add(1, 0, 10);
    set.delete(1, 3, 4); // remove 3-6

    expect(set.has(1, 2)).toBe(true);
    expect(set.has(1, 3)).toBe(false);
    expect(set.has(1, 6)).toBe(false);
    expect(set.has(1, 7)).toBe(true);
  });
});

describe("ContentIds", () => {
  it("merges content IDs", () => {
    const a = createContentIds();
    a.inserts.add(1, 0, 5);
    const b = createContentIds();
    b.inserts.add(1, 5, 5);
    b.inserts.add(2, 0, 3);

    const merged = mergeContentIds([a, b]);
    expect(merged.inserts.has(1, 0)).toBe(true);
    expect(merged.inserts.has(1, 9)).toBe(true);
    expect(merged.inserts.has(2, 2)).toBe(true);
  });

  it("excludes content IDs", () => {
    const a = createContentIds();
    a.inserts.add(1, 0, 10);
    const b = createContentIds();
    b.inserts.add(1, 3, 4);

    const diff = excludeContentIds(a, b);
    expect(diff.inserts.has(1, 2)).toBe(true);
    expect(diff.inserts.has(1, 3)).toBe(false);
    expect(diff.inserts.has(1, 7)).toBe(true);
  });

  it("intersects content IDs", () => {
    const a = createContentIds();
    a.inserts.add(1, 0, 10);
    const b = createContentIds();
    b.inserts.add(1, 5, 10);

    const result = intersectContentIds(a, b);
    expect(result.inserts.has(1, 4)).toBe(false);
    expect(result.inserts.has(1, 5)).toBe(true);
    expect(result.inserts.has(1, 9)).toBe(true);
    expect(result.inserts.has(1, 10)).toBe(false);
  });
});

describe("createContentIdsFromUpdate", () => {
  it("extracts insert ranges from a Y.js update", () => {
    const doc = new Y.Doc();
    doc.getText("test").insert(0, "hello world");
    const update = Y.encodeStateAsUpdateV2(doc);

    const ids = createContentIdsFromUpdate({ version: 2, data: update as UpdateV2 });
    const clientID = doc.clientID;

    expect(ids.inserts.has(clientID, 0)).toBe(true);
    expect(ids.inserts.has(clientID, 10)).toBe(true);
    expect(ids.inserts.has(clientID, 11)).toBe(false);
    expect(ids.deletes.isEmpty()).toBe(true);
  });

  it("extracts delete set from a Y.js update", () => {
    const doc = new Y.Doc();
    doc.getText("test").insert(0, "hello");
    doc.getText("test").delete(0, 3);
    const update = Y.encodeStateAsUpdateV2(doc);

    const ids = createContentIdsFromUpdate({ version: 2, data: update as UpdateV2 });
    expect(ids.deletes.has(doc.clientID, 0)).toBe(true);
    expect(ids.deletes.has(doc.clientID, 2)).toBe(true);
    expect(ids.deletes.has(doc.clientID, 3)).toBe(false);
  });

  it("handles multi-client updates", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    doc1.getText("t").insert(0, "aaa");
    Y.applyUpdateV2(doc2, Y.encodeStateAsUpdateV2(doc1));
    doc2.getText("t").insert(3, "bbb");
    Y.applyUpdateV2(doc1, Y.encodeStateAsUpdateV2(doc2));

    const update = Y.encodeStateAsUpdateV2(doc1);
    const ids = createContentIdsFromUpdate({ version: 2, data: update as UpdateV2 });

    expect(ids.inserts.has(doc1.clientID, 0)).toBe(true);
    expect(ids.inserts.has(doc1.clientID, 2)).toBe(true);
    expect(ids.inserts.has(doc2.clientID, 0)).toBe(true);
    expect(ids.inserts.has(doc2.clientID, 2)).toBe(true);
  });
});

describe("ContentMap", () => {
  it("creates content map from content IDs with attribution", () => {
    const ids = createContentIds();
    ids.inserts.add(1, 0, 5);
    ids.deletes.add(1, 10, 3);

    const map = createContentMapFromContentIds(
      ids,
      [createContentAttribute("insert", "user-1"), createContentAttribute("insertAt", 1_000_000)],
      [createContentAttribute("delete", "user-1"), createContentAttribute("deleteAt", 1_000_000)],
    );

    expect(map.inserts.has(1, 0)).toBe(true);
    expect(map.deletes.has(1, 10)).toBe(true);

    const insertSlice = map.inserts.slice(1, 0, 5);
    expect(insertSlice.length).toBe(1);
    expect(insertSlice[0].attrs).toBeDefined();
    expect(insertSlice[0].attrs!.length).toBe(2);
    expect(insertSlice[0].attrs![0].name).toBe("insert");
    expect(insertSlice[0].attrs![0].val).toBe("user-1");
  });

  it("merges multiple content maps", () => {
    const ids1 = createContentIds();
    ids1.inserts.add(1, 0, 5);
    const map1 = createContentMapFromContentIds(ids1, [createContentAttribute("insert", "user-1")]);

    const ids2 = createContentIds();
    ids2.inserts.add(1, 5, 5);
    const map2 = createContentMapFromContentIds(ids2, [createContentAttribute("insert", "user-2")]);

    const merged = mergeContentMaps([map1, map2]);
    expect(merged.inserts.has(1, 0)).toBe(true);
    expect(merged.inserts.has(1, 9)).toBe(true);
  });

  it("filters content map by predicate", () => {
    const ids = createContentIds();
    ids.inserts.add(1, 0, 5);
    ids.inserts.add(2, 0, 5);
    const map1 = createContentMapFromContentIds(
      {
        inserts: (() => {
          const s = new IdSet();
          s.add(1, 0, 5);
          return s;
        })(),
        deletes: new IdSet(),
      },
      [createContentAttribute("insert", "user-1")],
    );
    const map2 = createContentMapFromContentIds(
      {
        inserts: (() => {
          const s = new IdSet();
          s.add(2, 0, 5);
          return s;
        })(),
        deletes: new IdSet(),
      },
      [createContentAttribute("insert", "user-2")],
    );

    const merged = mergeContentMaps([map1, map2]);
    const filtered = filterContentMap(merged, (attrs) =>
      attrs.some((a) => a.name === "insert" && a.val === "user-1"),
    );

    expect(filtered.inserts.has(1, 0)).toBe(true);
    expect(filtered.inserts.clients.has(2)).toBe(false);
  });

  it("excludes content map by content IDs", () => {
    const ids = createContentIds();
    ids.inserts.add(1, 0, 10);
    const map = createContentMapFromContentIds(ids, [createContentAttribute("insert", "user-1")]);

    const exclude = createContentIds();
    exclude.inserts.add(1, 3, 4);

    const result = excludeContentMap(map, exclude);
    expect(result.inserts.has(1, 2)).toBe(true);
    expect(result.inserts.has(1, 3)).toBe(false);
    expect(result.inserts.has(1, 7)).toBe(true);
  });
});

describe("encoding round-trip", () => {
  it("encodes and decodes ContentIds", () => {
    const ids = createContentIds();
    ids.inserts.add(1, 0, 5);
    ids.inserts.add(1, 10, 3);
    ids.inserts.add(2, 0, 7);
    ids.deletes.add(1, 20, 2);

    const encoded = encodeContentIds(ids);
    const decoded = decodeContentIds(encoded);

    expect(decoded.inserts.has(1, 0)).toBe(true);
    expect(decoded.inserts.has(1, 4)).toBe(true);
    expect(decoded.inserts.has(1, 5)).toBe(false);
    expect(decoded.inserts.has(1, 10)).toBe(true);
    expect(decoded.inserts.has(2, 6)).toBe(true);
    expect(decoded.deletes.has(1, 20)).toBe(true);
    expect(decoded.deletes.has(1, 21)).toBe(true);
    expect(decoded.deletes.has(1, 22)).toBe(false);
  });

  it("encodes and decodes ContentMap with attributes", () => {
    const ids = createContentIds();
    ids.inserts.add(42, 0, 10);
    ids.deletes.add(42, 100, 5);

    const map = createContentMapFromContentIds(
      ids,
      [
        createContentAttribute("insert", "user-abc"),
        createContentAttribute("insertAt", 1_700_000_000),
      ],
      [
        createContentAttribute("delete", "user-abc"),
        createContentAttribute("deleteAt", 1_700_000_000),
      ],
    );

    const encoded = encodeContentMap(map);
    const decoded = decodeContentMap(encoded);

    expect(decoded.inserts.has(42, 0)).toBe(true);
    expect(decoded.inserts.has(42, 9)).toBe(true);
    expect(decoded.deletes.has(42, 100)).toBe(true);

    const insertSlice = decoded.inserts.slice(42, 0, 10);
    expect(insertSlice.length).toBe(1);
    expect(insertSlice[0].attrs!.length).toBe(2);
    expect(insertSlice[0].attrs![0].name).toBe("insert");
    expect(insertSlice[0].attrs![0].val).toBe("user-abc");
    expect(insertSlice[0].attrs![1].name).toBe("insertAt");
    expect(insertSlice[0].attrs![1].val).toBe(1_700_000_000);
  });

  it("handles empty ContentIds", () => {
    const ids = createContentIds();
    const encoded = encodeContentIds(ids);
    const decoded = decodeContentIds(encoded);
    expect(decoded.inserts.isEmpty()).toBe(true);
    expect(decoded.deletes.isEmpty()).toBe(true);
  });
});

describe("queries", () => {
  it("resolves item attribution", () => {
    const ids = createContentIds();
    ids.inserts.add(42, 0, 10);

    const map = createContentMapFromContentIds(ids, [
      createContentAttribute("insert", "user-1"),
      createContentAttribute("insertAt", 1_700_000_000),
    ]);

    const result = resolveItemAttribution(map, 42, 5);
    expect(result).toEqual({
      userId: "user-1",
      timestamp: 1_700_000_000,
      attributes: { insert: "user-1", insertAt: 1_700_000_000 },
    });

    expect(resolveItemAttribution(map, 42, 10)).toBeNull();
    expect(resolveItemAttribution(map, 99, 0)).toBeNull();
  });

  it("gets activity timeline", () => {
    const ids1 = createContentIds();
    ids1.inserts.add(1, 0, 5);
    const map1 = createContentMapFromContentIds(ids1, [
      createContentAttribute("insert", "user-1"),
      createContentAttribute("insertAt", 1000),
    ]);

    const ids2 = createContentIds();
    ids2.inserts.add(2, 0, 3);
    const map2 = createContentMapFromContentIds(ids2, [
      createContentAttribute("insert", "user-2"),
      createContentAttribute("insertAt", 2000),
    ]);

    const merged = mergeContentMaps([map1, map2]);
    const activity = getActivity(merged);

    expect(activity.length).toBe(2);
    expect(activity[0].userId).toBe("user-1");
    expect(activity[0].from).toBe(1000);
    expect(activity[1].userId).toBe("user-2");
    expect(activity[1].from).toBe(2000);
  });

  it("filters activity by userId", () => {
    const ids1 = createContentIds();
    ids1.inserts.add(1, 0, 5);
    const map1 = createContentMapFromContentIds(ids1, [
      createContentAttribute("insert", "user-1"),
      createContentAttribute("insertAt", 1000),
    ]);

    const ids2 = createContentIds();
    ids2.inserts.add(2, 0, 3);
    const map2 = createContentMapFromContentIds(ids2, [
      createContentAttribute("insert", "user-2"),
      createContentAttribute("insertAt", 2000),
    ]);

    const merged = mergeContentMaps([map1, map2]);
    const activity = getActivity(merged, { userId: "user-1" });

    expect(activity.length).toBe(1);
    expect(activity[0].userId).toBe("user-1");
  });

  it("filters activity by time range", () => {
    const ids1 = createContentIds();
    ids1.inserts.add(1, 0, 5);
    const map1 = createContentMapFromContentIds(ids1, [
      createContentAttribute("insert", "user-1"),
      createContentAttribute("insertAt", 1000),
    ]);

    const ids2 = createContentIds();
    ids2.inserts.add(2, 0, 3);
    const map2 = createContentMapFromContentIds(ids2, [
      createContentAttribute("insert", "user-2"),
      createContentAttribute("insertAt", 2000),
    ]);

    const merged = mergeContentMaps([map1, map2]);
    const activity = getActivity(merged, { from: 1500, to: 2500 });

    expect(activity.length).toBe(1);
    expect(activity[0].userId).toBe("user-2");
  });

  it("includes all attributes on activity entries", () => {
    const ids = createContentIds();
    ids.inserts.add(1, 0, 5);
    const map = createContentMapFromContentIds(ids, [
      createContentAttribute("insert", "user-1"),
      createContentAttribute("insertAt", 1000),
      createContentAttribute("source", "ai"),
    ]);

    const activity = getActivity(map);
    expect(activity.length).toBe(1);
    expect(activity[0].attributes).toEqual({
      insert: "user-1",
      insertAt: 1000,
      source: "ai",
    });
  });

  it("filters activity by custom attributes", () => {
    const ids1 = createContentIds();
    ids1.inserts.add(1, 0, 5);
    const map1 = createContentMapFromContentIds(ids1, [
      createContentAttribute("insert", "user-1"),
      createContentAttribute("insertAt", 1000),
      createContentAttribute("source", "ai"),
    ]);

    const ids2 = createContentIds();
    ids2.inserts.add(2, 0, 3);
    const map2 = createContentMapFromContentIds(ids2, [
      createContentAttribute("insert", "user-1"),
      createContentAttribute("insertAt", 2000),
      createContentAttribute("source", "human"),
    ]);

    const merged = mergeContentMaps([map1, map2]);

    const aiOnly = getActivity(merged, { attributes: { source: "ai" } });
    expect(aiOnly.length).toBe(1);
    expect(aiOnly[0].attributes.source).toBe("ai");

    const humanOnly = getActivity(merged, { attributes: { source: "human" } });
    expect(humanOnly.length).toBe(1);
    expect(humanOnly[0].attributes.source).toBe("human");
  });

  it("does not merge adjacent entries with different custom attributes", () => {
    const ids1 = createContentIds();
    ids1.inserts.add(1, 0, 5);
    const map1 = createContentMapFromContentIds(ids1, [
      createContentAttribute("insert", "user-1"),
      createContentAttribute("insertAt", 1000),
      createContentAttribute("source", "ai"),
    ]);

    const ids2 = createContentIds();
    ids2.inserts.add(2, 0, 3);
    const map2 = createContentMapFromContentIds(ids2, [
      createContentAttribute("insert", "user-1"),
      createContentAttribute("insertAt", 1000),
      createContentAttribute("source", "human"),
    ]);

    const merged = mergeContentMaps([map1, map2]);
    const activity = getActivity(merged);
    expect(activity.length).toBe(2);
  });

  it("resolveItemAttribution includes all attributes", () => {
    const ids = createContentIds();
    ids.inserts.add(42, 0, 10);
    const map = createContentMapFromContentIds(ids, [
      createContentAttribute("insert", "user-1"),
      createContentAttribute("insertAt", 1000),
      createContentAttribute("model", "claude-4"),
    ]);

    const result = resolveItemAttribution(map, 42, 5);
    expect(result).toEqual({
      userId: "user-1",
      timestamp: 1000,
      attributes: { insert: "user-1", insertAt: 1000, model: "claude-4" },
    });
  });
});

describe("AttrRanges.getIds overlap flattening", () => {
  const A = () => [createContentAttribute("insert", "user-A")];
  const B = () => [createContentAttribute("insert", "user-B")];
  const shape = (m: IdMap, client: number) =>
    m.clients
      .get(client)!
      .getIds()
      .map((r) => ({ clock: r.clock, len: r.len, u: r.attrs[0].val }));

  it("keeps the tail of a range that fully contains a later one", () => {
    const m = new IdMap();
    m.add(1, 0, 10, A());
    m.add(1, 3, 2, B()); // [3,5) contained inside [0,10)
    expect(shape(m, 1)).toEqual([
      { clock: 0, len: 3, u: "user-A" },
      { clock: 3, len: 2, u: "user-B" },
      { clock: 5, len: 5, u: "user-A" }, // tail preserved, not dropped
    ]);
  });

  it("flattens containment regardless of insertion order", () => {
    const m = new IdMap();
    m.add(1, 3, 2, B()); // contained range added first
    m.add(1, 0, 10, A());
    // The containing range was added later, so it wins the contested span.
    expect(shape(m, 1)).toEqual([{ clock: 0, len: 10, u: "user-A" }]);
  });

  it("splits partial overlaps, later-added range winning the contested span", () => {
    const m = new IdMap();
    m.add(1, 0, 5, A()); // [0,5)
    m.add(1, 3, 5, B()); // [3,8)
    expect(shape(m, 1)).toEqual([
      { clock: 0, len: 3, u: "user-A" },
      { clock: 3, len: 5, u: "user-B" },
    ]);
  });

  it("keeps adjacent ranges with differing attrs separate", () => {
    const m = new IdMap();
    m.add(1, 0, 5, A());
    m.add(1, 5, 5, B());
    expect(shape(m, 1)).toEqual([
      { clock: 0, len: 5, u: "user-A" },
      { clock: 5, len: 5, u: "user-B" },
    ]);
  });

  it("coalesces adjacent ranges with equal attrs", () => {
    const m = new IdMap();
    m.add(1, 0, 5, A());
    m.add(1, 5, 5, A());
    expect(shape(m, 1)).toEqual([{ clock: 0, len: 10, u: "user-A" }]);
  });

  it("preserves all spans when merging maps with overlapping deletes", () => {
    // Two users delete overlapping ranges of the same client's items in
    // separate updates; merged attribution must not silently lose either span.
    const delAttr = (u: string) => [createContentAttribute("delete", u)];
    const map1 = createContentMapFromContentIds(
      { inserts: new IdSet(), deletes: idSet(1, 0, 10) },
      [],
      delAttr("user-A"),
    );
    const map2 = createContentMapFromContentIds(
      { inserts: new IdSet(), deletes: idSet(1, 4, 2) },
      [],
      delAttr("user-B"),
    );
    const merged = mergeContentMaps([map1, map2]);
    expect(shapeDeletes(merged.deletes, 1)).toEqual([
      { clock: 0, len: 4, u: "user-A" },
      { clock: 4, len: 2, u: "user-B" },
      { clock: 6, len: 4, u: "user-A" },
    ]);
  });

  function idSet(client: number, clock: number, len: number): IdSet {
    const s = new IdSet();
    s.add(client, clock, len);
    return s;
  }
  function shapeDeletes(m: IdMap, client: number) {
    return m.clients
      .get(client)!
      .getIds()
      .map((r) => ({
        clock: r.clock,
        len: r.len,
        u: r.attrs.find((a) => a.name === "delete")?.val,
      }));
  }
});

describe("attribution insert/delete separation and custom attribute prefixing", () => {
  function attrsOf(
    map: ReturnType<typeof createContentMapFromContentIds>,
    side: "inserts" | "deletes",
    client: number,
  ) {
    const ranges = map[side].clients.get(client);
    if (!ranges) return [];
    return ranges.getIds().map((r) => Object.fromEntries(r.attrs.map((a) => [a.name, a.val])));
  }

  it("insert-only update: attrs land on inserts, deletes side is empty", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "hello");
    const update = Y.encodeStateAsUpdateV2(doc);

    const ids = createContentIdsFromUpdate({ version: 2, data: update as UpdateV2 });

    expect(ids.inserts.isEmpty()).toBe(false);
    expect(ids.deletes.isEmpty()).toBe(true);

    const map = createContentMapFromContentIds(
      ids,
      [createContentAttribute("insert", "alice"), createContentAttribute("insertAt", 1000)],
      [createContentAttribute("delete", "alice"), createContentAttribute("deleteAt", 1000)],
    );

    expect(attrsOf(map, "inserts", doc.clientID)).toEqual([{ insert: "alice", insertAt: 1000 }]);
    expect(map.deletes.isEmpty()).toBe(true);
  });

  it("delete-only: attrs land on deletes side only", () => {
    const ids = createContentIds();
    ids.deletes.add(1, 0, 3);

    const map = createContentMapFromContentIds(
      ids,
      [createContentAttribute("insert", "bob"), createContentAttribute("insertAt", 2000)],
      [createContentAttribute("delete", "bob"), createContentAttribute("deleteAt", 2000)],
    );

    expect(map.inserts.isEmpty()).toBe(true);
    expect(attrsOf(map, "deletes", 1)).toEqual([{ delete: "bob", deleteAt: 2000 }]);
  });

  it("mixed insert+delete update: each side gets only its own attrs", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "abcde");
    doc.getText("t").delete(1, 2);
    const update = Y.encodeStateAsUpdateV2(doc);

    const ids = createContentIdsFromUpdate({ version: 2, data: update as UpdateV2 });

    expect(ids.inserts.isEmpty()).toBe(false);
    expect(ids.deletes.isEmpty()).toBe(false);

    const map = createContentMapFromContentIds(
      ids,
      [createContentAttribute("insert", "carol"), createContentAttribute("insertAt", 3000)],
      [createContentAttribute("delete", "carol"), createContentAttribute("deleteAt", 3000)],
    );

    for (const attrs of attrsOf(map, "inserts", doc.clientID)) {
      expect(attrs).toHaveProperty("insert", "carol");
      expect(attrs).toHaveProperty("insertAt", 3000);
      expect(attrs).not.toHaveProperty("delete");
      expect(attrs).not.toHaveProperty("deleteAt");
    }

    for (const attrs of attrsOf(map, "deletes", doc.clientID)) {
      expect(attrs).toHaveProperty("delete", "carol");
      expect(attrs).toHaveProperty("deleteAt", 3000);
      expect(attrs).not.toHaveProperty("insert");
      expect(attrs).not.toHaveProperty("insertAt");
    }
  });

  it("custom attributes round-trip through encoding on both sides", () => {
    const ids = createContentIds();
    ids.inserts.add(1, 0, 5);
    ids.deletes.add(1, 10, 3);

    const customAttrs = [
      createContentAttribute("source", "ai"),
      createContentAttribute("model", "claude-4"),
    ];
    const insertAttrs = [
      createContentAttribute("insert", "user-1"),
      createContentAttribute("insertAt", 1000),
      ...customAttrs,
    ];
    const deleteAttrs = [
      createContentAttribute("delete", "user-1"),
      createContentAttribute("deleteAt", 1000),
      ...customAttrs,
    ];

    const map = createContentMapFromContentIds(ids, insertAttrs, deleteAttrs);

    const encoded = encodeContentMap(map);
    const decoded = decodeContentMap(encoded);

    expect(attrsOf(decoded, "inserts", 1)).toEqual([
      { insert: "user-1", insertAt: 1000, source: "ai", model: "claude-4" },
    ]);

    expect(attrsOf(decoded, "deletes", 1)).toEqual([
      { delete: "user-1", deleteAt: 1000, source: "ai", model: "claude-4" },
    ]);
  });

  it("simulates server #computeAttribution: custom attrs stored flat on both sides", () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "hello");
    doc.getText("t").delete(0, 2);
    const update = Y.encodeStateAsUpdateV2(doc);

    const contentIds = createContentIdsFromUpdate({ version: 2, data: update as UpdateV2 });
    const userId = "user-1";
    const now = 5000;

    const customAttrs = [
      createContentAttribute("source", "ai"),
      createContentAttribute("model", "claude-4"),
    ];

    const insertAttrs = [
      createContentAttribute("insert", userId),
      createContentAttribute("insertAt", now),
      ...customAttrs,
    ];
    const deleteAttrs = [
      createContentAttribute("delete", userId),
      createContentAttribute("deleteAt", now),
      ...customAttrs,
    ];

    const map = createContentMapFromContentIds(contentIds, insertAttrs, deleteAttrs);
    const encoded = encodeContentMap(map);
    const decoded = decodeContentMap(encoded);

    for (const attrs of attrsOf(decoded, "inserts", doc.clientID)) {
      expect(attrs).toEqual({
        insert: "user-1",
        insertAt: 5000,
        source: "ai",
        model: "claude-4",
      });
    }

    for (const attrs of attrsOf(decoded, "deletes", doc.clientID)) {
      expect(attrs).toEqual({
        delete: "user-1",
        deleteAt: 5000,
        source: "ai",
        model: "claude-4",
      });
    }

    const activity = getActivity(decoded);
    expect(activity.length).toBeGreaterThanOrEqual(1);
    for (const entry of activity) {
      expect(entry.userId).toBe("user-1");
      expect(entry.attributes).toHaveProperty("source", "ai");
      expect(entry.attributes).toHaveProperty("model", "claude-4");
    }
  });

  it("getActivity returns delete-side activity with flat custom attrs", () => {
    const ids = createContentIds();
    ids.deletes.add(1, 0, 5);

    const map = createContentMapFromContentIds(
      ids,
      [],
      [
        createContentAttribute("delete", "user-1"),
        createContentAttribute("deleteAt", 9000),
        createContentAttribute("source", "human"),
      ],
    );

    const activity = getActivity(map);
    expect(activity).toEqual([
      {
        from: 9000,
        to: 9000,
        userId: "user-1",
        attributes: { delete: "user-1", deleteAt: 9000, source: "human" },
      },
    ]);
  });

  it("resolveItemAttribution only looks at the insert side", () => {
    const ids = createContentIds();
    ids.inserts.add(1, 0, 5);
    ids.deletes.add(1, 0, 5);

    const map = createContentMapFromContentIds(
      ids,
      [
        createContentAttribute("insert", "inserter"),
        createContentAttribute("insertAt", 1000),
        createContentAttribute("source", "ai"),
      ],
      [
        createContentAttribute("delete", "deleter"),
        createContentAttribute("deleteAt", 2000),
        createContentAttribute("source", "human"),
      ],
    );

    const result = resolveItemAttribution(map, 1, 2);
    expect(result).toEqual({
      userId: "inserter",
      timestamp: 1000,
      attributes: { insert: "inserter", insertAt: 1000, source: "ai" },
    });
  });
});
