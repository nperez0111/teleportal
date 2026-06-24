import { describe, expect, it } from "bun:test";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import {
  stripContent,
  restoreContent,
  mergeSidecars,
  buildSidecarIndex,
  buildSidecarIndexFromUpdateMeta,
  sidecarOverlapsDiff,
  type ContentEntry,
  type Sidecar,
  type SidecarIndex,
} from "./content-cipher";

// ── Helpers ───────────────────────────────────────────────────────────────

type DiffMeta = { from: Map<number, number>; to: Map<number, number> };

/** A diff range that covers exactly the single clock `clock` for `clientId`. */
function singleClockDiff(clientId: number, clock: number): DiffMeta {
  return {
    from: new Map([[clientId, clock]]),
    to: new Map([[clientId, clock + 1]]),
  };
}

// Valid sidecar bytes for a single-character string (contentRef 4), so the
// entry spans exactly one clock (itemLength derives from the content data).
const ONE_CHAR_STRING = encoding.encode((e) => encoding.writeVarString(e, "x"));

function entry(clientId: number, clock: number, contentRef = 4): ContentEntry {
  return { clientId, clock, contentRef, data: ONE_CHAR_STRING };
}

/**
 * Build a realistic two-client merged Y.Doc with a rich mix of content types,
 * returning the merged full V2 update.
 */
function buildTwoClientUpdate(): Uint8Array {
  const docA = new Y.Doc();
  docA.clientID = 11;
  docA.getText("t").insert(0, "Hello World");
  docA.getText("t").format(0, 5, { bold: true });
  docA.getText("t").insertEmbed(11, { image: "https://x/y.png" });
  docA.getMap("m").set("k1", "v1");
  docA.getMap("m").set("k2", 99);
  docA.getArray("arr").insert(0, ["x", "y", true, null, 3.14]);

  const docB = new Y.Doc();
  docB.clientID = 22;
  // B starts from A's full state so the merge is a valid causal history.
  Y.applyUpdateV2(docB, Y.encodeStateAsUpdateV2(docA));
  docB.getText("t").insert(0, "BBB");
  docB.getMap("m").set("k3", "fromB");
  docB.getArray("arr").insert(0, [{ nested: "obj" }]);

  // Merge B back into A → converged full state.
  Y.applyUpdateV2(docA, Y.encodeStateAsUpdateV2(docB));
  return Y.encodeStateAsUpdateV2(docA);
}

// ── buildSidecarIndex ───────────────────────────────────────────────────────

describe("buildSidecarIndex", () => {
  it("collapses entries into per-client [min,max] ranges", () => {
    const entries: ContentEntry[] = [
      entry(1, 0),
      entry(1, 5),
      entry(1, 3),
      entry(2, 7),
      entry(2, 2),
    ];
    const index = buildSidecarIndex(entries);
    expect(index).toEqual([
      { clientId: 1, minClock: 0, maxClock: 5 },
      { clientId: 2, minClock: 2, maxClock: 7 },
    ]);
  });

  it("returns an empty index for empty entries", () => {
    expect(buildSidecarIndex([])).toEqual([]);
  });

  it("produces a degenerate min==max range for a single entry", () => {
    expect(buildSidecarIndex([entry(42, 7)])).toEqual([{ clientId: 42, minClock: 7, maxClock: 7 }]);
  });

  it("ignores entry order when computing ranges (idempotent on permutation)", () => {
    const a = buildSidecarIndex([entry(5, 9), entry(5, 1), entry(5, 4)]);
    const b = buildSidecarIndex([entry(5, 4), entry(5, 9), entry(5, 1)]);
    expect(a).toEqual(b);
    expect(a).toEqual([{ clientId: 5, minClock: 1, maxClock: 9 }]);
  });

  it("matches the index derived from a real stripped update's entries", () => {
    const doc = new Y.Doc();
    doc.clientID = 1;
    doc.getText("t").insert(0, "Hello");
    doc.getMap("m").set("a", 1);
    const { sidecar } = stripContent(Y.encodeStateAsUpdateV2(doc), 2);

    const index = buildSidecarIndex(sidecar.entries);
    // Single client; min/max must bracket every entry clock.
    const clocks = sidecar.entries.map((e) => e.clock);
    expect(index.length).toBe(1);
    expect(index[0].clientId).toBe(1);
    expect(index[0].minClock).toBe(Math.min(...clocks));
    expect(index[0].maxClock).toBe(Math.max(...clocks));
  });
});

// ── buildSidecarIndexFromUpdateMeta ─────────────────────────────────────────

describe("buildSidecarIndexFromUpdateMeta", () => {
  it("maps from→minClock and (to-1)→maxClock", () => {
    const index = buildSidecarIndexFromUpdateMeta({
      from: new Map([[1, 5]]),
      to: new Map([[1, 11]]),
    });
    expect(index).toEqual([{ clientId: 1, minClock: 5, maxClock: 10 }]);
  });

  it("handles multiple clients independently", () => {
    const index = buildSidecarIndexFromUpdateMeta({
      from: new Map([
        [1, 0],
        [2, 3],
      ]),
      to: new Map([
        [1, 5],
        [2, 4],
      ]),
    });
    expect(index).toEqual([
      { clientId: 1, minClock: 0, maxClock: 4 },
      { clientId: 2, minClock: 3, maxClock: 3 },
    ]);
  });

  it("falls back to (from+1)-1 == from when `to` lacks the client (single-clock range)", () => {
    // The `(to.get(clientId) ?? from+1) - 1` math: with `to` missing the
    // client, maxClock collapses to `from`, i.e. a 1-clock range. Real Y.js
    // never emits this (every `from` client appears in `to`), but the function
    // is defined for it.
    const index = buildSidecarIndexFromUpdateMeta({
      from: new Map([[9, 3]]),
      to: new Map(),
    });
    expect(index).toEqual([{ clientId: 9, minClock: 3, maxClock: 3 }]);
  });

  it("returns an empty index for an empty `from`", () => {
    expect(buildSidecarIndexFromUpdateMeta({ from: new Map(), to: new Map() })).toEqual([]);
  });

  it("derives the expected range from a real incremental update's meta", () => {
    const doc = new Y.Doc();
    doc.clientID = 1;
    doc.getText("t").insert(0, "Hello");
    const sv = Y.encodeStateVector(doc);
    doc.getText("t").insert(5, " World");
    const inc = Y.encodeStateAsUpdateV2(doc, sv);

    const meta = Y.parseUpdateMetaV2(inc);
    const index = buildSidecarIndexFromUpdateMeta(meta);
    expect(index.length).toBe(1);
    expect(index[0].clientId).toBe(1);
    expect(index[0].minClock).toBe(5);
    // " World" = 6 chars at clocks 5..10; `to` is exclusive (11) → max 10.
    expect(index[0].maxClock).toBe(10);
  });

  it("meta-derived range is a SUPERSET of the entries-derived range (never under-covers)", () => {
    // This is the safety property the server relies on: the index built from
    // parsed meta must bracket every real sidecar entry. The meta `to` is the
    // next clock after the last struct (possibly a non-encryptable trailing
    // struct), so its maxClock is >= the true max entry clock, never below.
    const full = buildTwoClientUpdate();
    const { update: structureUpdate, sidecar } = stripContent(full, 2);
    const metaIndex = buildSidecarIndexFromUpdateMeta(Y.parseUpdateMetaV2(structureUpdate));
    const entriesIndex = buildSidecarIndex(sidecar.entries);

    for (const er of entriesIndex) {
      const mr = metaIndex.find((r) => r.clientId === er.clientId);
      expect(mr).toBeDefined();
      expect(mr!.minClock).toBeLessThanOrEqual(er.minClock);
      expect(mr!.maxClock).toBeGreaterThanOrEqual(er.maxClock);
    }
  });
});

// ── sidecarOverlapsDiff: boundary logic ─────────────────────────────────────

describe("sidecarOverlapsDiff", () => {
  const index: SidecarIndex = [{ clientId: 1, minClock: 5, maxClock: 10 }];

  it("overlaps when the diff fully contains the range", () => {
    expect(sidecarOverlapsDiff(index, { from: new Map([[1, 0]]), to: new Map([[1, 20]]) })).toBe(
      true,
    );
  });

  it("does not overlap when the range is entirely before the diff", () => {
    // range 5..10, diff [11,20): maxClock(10) >= diffFrom(11) is false.
    expect(sidecarOverlapsDiff(index, { from: new Map([[1, 11]]), to: new Map([[1, 20]]) })).toBe(
      false,
    );
  });

  it("does not overlap when the range is entirely after the diff", () => {
    // range 5..10, diff [0,5): minClock(5) < diffTo(5) is false.
    expect(sidecarOverlapsDiff(index, { from: new Map([[1, 0]]), to: new Map([[1, 5]]) })).toBe(
      false,
    );
  });

  it("BOUNDARY: maxClock == diffFrom overlaps (diffFrom is inclusive)", () => {
    // range 3..5, diff [5,10): maxClock(5) >= diffFrom(5) && minClock(3) < 10.
    expect(
      sidecarOverlapsDiff([{ clientId: 1, minClock: 3, maxClock: 5 }], {
        from: new Map([[1, 5]]),
        to: new Map([[1, 10]]),
      }),
    ).toBe(true);
  });

  it("BOUNDARY: minClock == diffTo does NOT overlap (diffTo is exclusive / half-open)", () => {
    // range 10..15, diff [5,10): minClock(10) < diffTo(10) is false.
    expect(
      sidecarOverlapsDiff([{ clientId: 1, minClock: 10, maxClock: 15 }], {
        from: new Map([[1, 5]]),
        to: new Map([[1, 10]]),
      }),
    ).toBe(false);
  });

  it("BOUNDARY: one-past-the-end does NOT overlap", () => {
    // range 5..10, single-clock diff at 11 → [11,12): no overlap.
    expect(sidecarOverlapsDiff(index, singleClockDiff(1, 11))).toBe(false);
    // ...but exactly at maxClock (10) overlaps.
    expect(sidecarOverlapsDiff(index, singleClockDiff(1, 10))).toBe(true);
    // ...and exactly at minClock (5) overlaps.
    expect(sidecarOverlapsDiff(index, singleClockDiff(1, 5))).toBe(true);
    // ...and one-before-the-start (4) does not.
    expect(sidecarOverlapsDiff(index, singleClockDiff(1, 4))).toBe(false);
  });

  it("adjacent-but-disjoint ranges do not overlap (touching at the half-open seam)", () => {
    // sidecar range 0..4, diff [5,10): disjoint and adjacent → no overlap.
    expect(
      sidecarOverlapsDiff([{ clientId: 1, minClock: 0, maxClock: 4 }], {
        from: new Map([[1, 5]]),
        to: new Map([[1, 10]]),
      }),
    ).toBe(false);
    // sidecar range 10..15, diff [5,10): adjacent on the other side → no overlap.
    expect(
      sidecarOverlapsDiff([{ clientId: 1, minClock: 10, maxClock: 15 }], {
        from: new Map([[1, 5]]),
        to: new Map([[1, 10]]),
      }),
    ).toBe(false);
  });

  it("ignores a sidecar client absent from the diff", () => {
    expect(
      sidecarOverlapsDiff([{ clientId: 99, minClock: 0, maxClock: 100 }], {
        from: new Map([[1, 0]]),
        to: new Map([[1, 50]]),
      }),
    ).toBe(false);
  });

  it("multiple clients: overlaps if ANY range overlaps, even when others don't", () => {
    const multi: SidecarIndex = [
      { clientId: 1, minClock: 0, maxClock: 5 }, // outside the diff
      { clientId: 2, minClock: 0, maxClock: 10 }, // overlaps
    ];
    expect(sidecarOverlapsDiff(multi, { from: new Map([[2, 5]]), to: new Map([[2, 15]]) })).toBe(
      true,
    );
  });

  it("multiple clients: no overlap when every per-client range misses", () => {
    const multi: SidecarIndex = [
      { clientId: 1, minClock: 0, maxClock: 4 },
      { clientId: 2, minClock: 0, maxClock: 4 },
    ];
    const diffMeta: DiffMeta = {
      from: new Map([
        [1, 5],
        [2, 5],
      ]),
      to: new Map([
        [1, 10],
        [2, 10],
      ]),
    };
    expect(sidecarOverlapsDiff(multi, diffMeta)).toBe(false);
  });

  it("returns false for an empty index", () => {
    expect(sidecarOverlapsDiff([], { from: new Map([[1, 0]]), to: new Map([[1, 10]]) })).toBe(
      false,
    );
  });

  it("returns false for an empty diffMeta", () => {
    expect(
      sidecarOverlapsDiff([{ clientId: 1, minClock: 0, maxClock: 10 }], {
        from: new Map(),
        to: new Map(),
      }),
    ).toBe(false);
  });
});

// ── CRITICAL INVARIANT: real updates, every entry is covered ────────────────

describe("CRITICAL INVARIANT: sidecar index covers every real entry", () => {
  function expectEveryEntryCovered(full: Uint8Array) {
    const { update: structureUpdate, sidecar } = stripContent(full, 2);
    const index = buildSidecarIndexFromUpdateMeta(Y.parseUpdateMetaV2(structureUpdate));

    expect(sidecar.entries.length).toBeGreaterThan(0);
    for (const e of sidecar.entries) {
      // A diff that covers exactly this entry's clock MUST report overlap,
      // otherwise the server would under-send and restoreContent would throw.
      expect(sidecarOverlapsDiff(index, singleClockDiff(e.clientId, e.clock))).toBe(true);
    }
  }

  it("single-client doc with mixed content types", () => {
    const doc = new Y.Doc();
    doc.clientID = 1;
    doc.getText("t").insert(0, "Hello World");
    doc.getText("t").format(0, 5, { bold: true });
    doc.getMap("m").set("a", 1);
    doc.getMap("m").set("b", "two");
    doc.getArray("arr").insert(0, ["x", "y", true, null]);
    expectEveryEntryCovered(Y.encodeStateAsUpdateV2(doc));
  });

  it("two-client merged doc (multiple Y.Doc instances merged)", () => {
    expectEveryEntryCovered(buildTwoClientUpdate());
  });

  it("incremental update (not full state)", () => {
    const doc = new Y.Doc();
    doc.clientID = 7;
    doc.getText("t").insert(0, "Hello");
    const sv = Y.encodeStateVector(doc);
    doc.getText("t").insert(5, " World");
    doc.getMap("m").set("late", "value");
    const inc = Y.encodeStateAsUpdateV2(doc, sv);
    expectEveryEntryCovered(inc);
  });

  it("character-by-character typing across many structs", () => {
    const doc = new Y.Doc();
    doc.clientID = 3;
    const text = doc.getText("t");
    for (let i = 0; i < 50; i++) text.insert(i, String.fromCharCode(65 + (i % 26)));
    expectEveryEntryCovered(Y.encodeStateAsUpdateV2(doc));
  });

  it("doc with deletions interleaved (tombstones between content)", () => {
    const doc = new Y.Doc();
    doc.clientID = 4;
    const text = doc.getText("t");
    text.insert(0, "ABCDEFGHIJ");
    text.delete(2, 3);
    text.insert(2, "XYZ");
    doc.getMap("m").set("k", "v");
    expectEveryEntryCovered(Y.encodeStateAsUpdateV2(doc));
  });
});

// ── End-to-end: server filtering must not under-send ────────────────────────

describe("end-to-end server filtering preserves restoreContent", () => {
  /**
   * Simulate the real server flow: accumulate per-update sidecars, then for a
   * client's partial state vector, send the diff + only the overlapping
   * sidecars, and assert restoreContent succeeds on the diff with exactly
   * those sidecars (the under-send bug would make restoreContent throw).
   */
  it("filters out already-known sidecars yet restoreContent still succeeds", () => {
    type Piece = { structure: Uint8Array; sidecar: Sidecar; index: SidecarIndex };
    const pieces: Piece[] = [];

    const docA = new Y.Doc();
    docA.clientID = 1;
    const docB = new Y.Doc();
    docB.clientID = 2;

    function record(doc: Y.Doc, beforeSV: Uint8Array): Uint8Array {
      const inc = Y.encodeStateAsUpdateV2(doc, beforeSV);
      const { update: structure, sidecar } = stripContent(inc, 2);
      pieces.push({ structure, sidecar, index: buildSidecarIndex(sidecar.entries) });
      return structure;
    }

    let svA = Y.encodeStateVector(docA);
    docA.getText("t").insert(0, "Hello");
    const s1 = record(docA, svA);

    svA = Y.encodeStateVector(docA);
    docA.getText("t").insert(5, " World");
    docA.getMap("m").set("fromA", "secretA");
    const s2 = record(docA, svA);

    // B causally follows A's structure, then makes its own content edit.
    Y.applyUpdateV2(docB, Y.mergeUpdatesV2([s1, s2]));
    const svB = Y.encodeStateVector(docB);
    docB.getMap("m").set("fromB", "secretB");
    const s3 = record(docB, svB);

    const serverStructure = Y.mergeUpdatesV2([s1, s2, s3]);

    // Client already has s1 only; requests the rest.
    const clientDoc = new Y.Doc();
    Y.applyUpdateV2(clientDoc, s1);
    const diff = Y.diffUpdateV2(serverStructure, Y.encodeStateVector(clientDoc));
    const diffMeta = Y.parseUpdateMetaV2(diff);

    const sent = pieces.filter((p) => sidecarOverlapsDiff(p.index, diffMeta));
    // s1 is already known → excluded; s2 and s3 carry new content → included.
    expect(sent.length).toBe(2);
    expect(sent.includes(pieces[0])).toBe(false);
    expect(sent.includes(pieces[1])).toBe(true);
    expect(sent.includes(pieces[2])).toBe(true);

    // restoreContent on the diff with exactly the sent sidecars must succeed.
    const merged = mergeSidecars(sent.map((p) => p.sidecar));
    let restored: Uint8Array;
    expect(() => {
      restored = restoreContent(diff, merged, 2);
    }).not.toThrow();

    Y.applyUpdateV2(clientDoc, restored!);
    expect(clientDoc.getMap("m").get("fromA")).toBe("secretA");
    expect(clientDoc.getMap("m").get("fromB")).toBe("secretB");
  });

  it("dropping an overlapping sidecar makes restoreContent throw (proves filtering is load-bearing)", () => {
    // Negative control: confirm that the entries the filter KEEPS are truly
    // required — removing one that overlaps the diff triggers the loud failure.
    const docA = new Y.Doc();
    docA.clientID = 1;
    docA.getText("t").insert(0, "Hello");
    const inc = Y.encodeStateAsUpdateV2(docA);
    const { update: structure, sidecar } = stripContent(inc, 2);

    const diff = Y.diffUpdateV2(structure, Y.encodeStateVector(new Y.Doc()));

    // Restoring with the real sidecar works...
    expect(() => restoreContent(diff, sidecar, 2)).not.toThrow();
    // ...but with an empty sidecar (the bug: under-sent), it throws loudly.
    expect(() => restoreContent(diff, { entries: [], dictionary: new Map() }, 2)).toThrow(
      /missing sidecar entry/,
    );
  });

  it("empty client state vector pulls every sidecar", () => {
    const docA = new Y.Doc();
    docA.clientID = 1;
    docA.getText("t").insert(0, "Hello");
    const { update: sA, sidecar: scA } = stripContent(Y.encodeStateAsUpdateV2(docA), 2);
    const indexA = buildSidecarIndex(scA.entries);

    const docB = new Y.Doc();
    docB.clientID = 2;
    docB.getText("t").insert(0, "World");
    const { update: sB, sidecar: scB } = stripContent(Y.encodeStateAsUpdateV2(docB), 2);
    const indexB = buildSidecarIndex(scB.entries);

    const merged = Y.mergeUpdatesV2([sA, sB]);
    const diff = Y.diffUpdateV2(merged, Y.encodeStateVector(new Y.Doc()));
    const diffMeta = Y.parseUpdateMetaV2(diff);

    expect(sidecarOverlapsDiff(indexA, diffMeta)).toBe(true);
    expect(sidecarOverlapsDiff(indexB, diffMeta)).toBe(true);
  });
});
