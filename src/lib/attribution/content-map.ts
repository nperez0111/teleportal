/**
 * ContentMap and related types — reimplemented from Y.js v14 (src/utils/meta.js + ids.js).
 *
 * A ContentMap maps CRDT operation ID ranges to attribution metadata (ContentAttributes).
 * It extends the IdSet concept (from content-ids.ts) by attaching attributes to each range.
 *
 * Example: ContentMap saying "user-123 inserted items (client=42, clock=0..10) at timestamp 1700000000":
 *   inserts: IdMap { 42 → [{clock: 0, len: 10, attrs: [{name: "insert", val: "user-123"}, {name: "insertAt", val: 1700000000}]}] }
 */

import { type ContentIds, IdSet } from "./content-ids";

// --- ContentAttribute ---

export class ContentAttribute<V = unknown> {
  constructor(
    public name: string,
    public val: V,
  ) {}
}

export function createContentAttribute<V>(name: string, val: V): ContentAttribute<V> {
  return new ContentAttribute(name, val);
}

// --- AttrRange ---

export class AttrRange {
  constructor(
    public clock: number,
    public len: number,
    public attrs: ContentAttribute[],
  ) {}

  copyWith(clock: number, len: number): AttrRange {
    return new AttrRange(clock, len, this.attrs);
  }
}

export interface MaybeAttrRange {
  clock: number;
  len: number;
  attrs?: ContentAttribute[];
}

// --- AttrRanges ---

export class AttrRanges {
  private _ids: AttrRange[];
  private _sorted = false;

  constructor(ids: AttrRange[] = []) {
    this._ids = ids;
    this._sorted = ids.length <= 1;
  }

  add(clock: number, length: number, attrs: ContentAttribute[]) {
    const ids = this._ids;
    if (ids.length > 0) {
      const last = ids.at(-1)!;
      if (last.clock + last.len === clock && attrsEqual(last.attrs, attrs)) {
        last.len += length;
        return;
      }
    }
    ids.push(new AttrRange(clock, length, attrs));
    this._sorted = false;
  }

  getIds(): AttrRange[] {
    if (this._sorted) {
      return this._ids;
    }

    // Flatten the (possibly overlapping) input ranges into a sorted,
    // non-overlapping sequence. Where ranges overlap with differing attrs the
    // most-recently-added range (highest input index) wins the contested span;
    // every non-contested span keeps its own attrs. Spans of every covering
    // range — including the tail of a range that fully contains a later one —
    // are preserved, then adjacent equal-attr spans are coalesced.
    const input = this._ids;
    const boundaries = new Set<number>();
    for (const range of input) {
      boundaries.add(range.clock);
      boundaries.add(range.clock + range.len);
    }
    const points = [...boundaries].sort((a, b) => a - b);

    const merged: AttrRange[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const start = points[i];
      const end = points[i + 1];

      // Every range boundary is a point, so each range either fully covers this
      // elementary span or does not intersect it. Pick the latest-added cover.
      let winner: AttrRange | undefined;
      let winnerIdx = -1;
      for (const [j, range] of input.entries()) {
        if (range.clock <= start && range.clock + range.len >= end && j > winnerIdx) {
          winner = range;
          winnerIdx = j;
        }
      }
      if (!winner) {
        continue;
      }

      const last = merged.at(-1);
      if (last && last.clock + last.len === start && attrsEqual(last.attrs, winner.attrs)) {
        last.len = end - last.clock;
      } else {
        merged.push(new AttrRange(start, end - start, winner.attrs));
      }
    }

    this._ids = merged;
    this._sorted = true;
    return this._ids;
  }

  copy(): AttrRanges {
    return new AttrRanges(this.getIds().map((r) => new AttrRange(r.clock, r.len, [...r.attrs])));
  }
}

function attrsEqual(a: ContentAttribute[], b: ContentAttribute[]): boolean {
  if (a.length !== b.length) return false;
  for (const [i, element_] of a.entries()) {
    if (element_.name !== b[i].name || element_.val !== b[i].val) return false;
  }
  return true;
}

// --- IdMap ---

export class IdMap {
  clients: Map<number, AttrRanges> = new Map();

  isEmpty(): boolean {
    if (this.clients.size === 0) return true;
    for (const ranges of this.clients.values()) {
      if (ranges.getIds().length > 0) return false;
    }
    return true;
  }

  add(client: number, clock: number, len: number, attrs: ContentAttribute[]) {
    let ranges = this.clients.get(client);
    if (!ranges) {
      ranges = new AttrRanges();
      this.clients.set(client, ranges);
    }
    ranges.add(clock, len, attrs);
  }

  has(client: number, clock: number): boolean {
    const ranges = this.clients.get(client);
    if (!ranges) return false;
    const ids = ranges.getIds();
    for (const range of ids) {
      if (clock >= range.clock && clock < range.clock + range.len) return true;
    }
    return false;
  }

  /**
   * Returns which portions of [clock, clock+len) exist in this map,
   * with their associated attributes.
   */
  slice(client: number, clock: number, len: number): MaybeAttrRange[] {
    const ranges = this.clients.get(client);
    if (!ranges) {
      return [{ clock, len }];
    }
    const ids = ranges.getIds();
    const result: MaybeAttrRange[] = [];
    let pos = clock;
    const end = clock + len;

    for (const range of ids) {
      if (range.clock >= end) break;
      const rangeEnd = range.clock + range.len;
      if (rangeEnd <= pos) continue;

      if (pos < range.clock) {
        const gapEnd = Math.min(range.clock, end);
        result.push({ clock: pos, len: gapEnd - pos });
        pos = gapEnd;
      }

      if (pos < end && pos < rangeEnd) {
        const overlapEnd = Math.min(rangeEnd, end);
        result.push({ clock: pos, len: overlapEnd - pos, attrs: range.attrs });
        pos = overlapEnd;
      }
    }

    if (pos < end) {
      result.push({ clock: pos, len: end - pos });
    }

    return result;
  }

  forEach(f: (client: number, clock: number, len: number, attrs: ContentAttribute[]) => void) {
    for (const [client, ranges] of this.clients.entries()) {
      for (const range of ranges.getIds()) {
        f(client, range.clock, range.len, range.attrs);
      }
    }
  }
}

// --- ContentMap ---

export interface ContentMap {
  inserts: IdMap;
  deletes: IdMap;
}

export function createContentMap(inserts?: IdMap, deletes?: IdMap): ContentMap {
  return {
    inserts: inserts ?? new IdMap(),
    deletes: deletes ?? new IdMap(),
  };
}

/**
 * Create a ContentMap from ContentIds by tagging all insert ranges with insertAttrs
 * and all delete ranges with deleteAttrs.
 */
export function createContentMapFromContentIds(
  contentIds: ContentIds,
  insertAttrs: ContentAttribute[],
  deleteAttrs: ContentAttribute[] = insertAttrs,
): ContentMap {
  const inserts = new IdMap();
  contentIds.inserts.forEach((client, clock, len) => {
    inserts.add(client, clock, len, insertAttrs);
  });

  const deletes = new IdMap();
  contentIds.deletes.forEach((client, clock, len) => {
    deletes.add(client, clock, len, deleteAttrs);
  });

  return { inserts, deletes };
}

export function mergeContentMaps(maps: ContentMap[]): ContentMap {
  return createContentMap(
    mergeIdMaps(maps.map((m) => m.inserts)),
    mergeIdMaps(maps.map((m) => m.deletes)),
  );
}

function mergeIdMaps(maps: IdMap[]): IdMap {
  const merged = new IdMap();
  for (const map of maps) {
    for (const [client, ranges] of map.clients.entries()) {
      for (const range of ranges.getIds()) {
        merged.add(client, range.clock, range.len, range.attrs);
      }
    }
  }
  return merged;
}

/**
 * Filter a ContentMap by predicates on the attribute arrays.
 * Only ranges where the predicate returns true are kept.
 */
export function filterContentMap(
  contentMap: ContentMap,
  insertPredicate: (attrs: ContentAttribute[]) => boolean,
  deletePredicate: (attrs: ContentAttribute[]) => boolean = insertPredicate,
): ContentMap {
  return createContentMap(
    filterIdMap(contentMap.inserts, insertPredicate),
    filterIdMap(contentMap.deletes, deletePredicate),
  );
}

function filterIdMap(idMap: IdMap, predicate: (attrs: ContentAttribute[]) => boolean): IdMap {
  const filtered = new IdMap();
  for (const [client, ranges] of idMap.clients.entries()) {
    for (const range of ranges.getIds()) {
      if (predicate(range.attrs)) {
        filtered.add(client, range.clock, range.len, range.attrs);
      }
    }
  }
  return filtered;
}

/**
 * Exclude ranges from a ContentMap that are present in the exclude ContentIds.
 * This prevents double-attribution when merging updates that share operations.
 */
export function excludeContentMap(content: ContentMap, exclude: ContentIds): ContentMap {
  return createContentMap(
    excludeIdMapByIdSet(content.inserts, exclude.inserts),
    excludeIdMapByIdSet(content.deletes, exclude.deletes),
  );
}

function excludeIdMapByIdSet(idMap: IdMap, exclude: IdSet): IdMap {
  const result = new IdMap();
  for (const [client, ranges] of idMap.clients.entries()) {
    for (const range of ranges.getIds()) {
      const slices = exclude.slice(client, range.clock, range.len);
      for (const s of slices) {
        if (!s.exists) {
          result.add(client, s.clock, s.len, range.attrs);
        }
      }
    }
  }
  return result;
}

/**
 * Intersect a ContentMap with ContentIds, keeping only ranges that exist in both.
 */
export function intersectContentMap(contentMap: ContentMap, contentIds: ContentIds): ContentMap {
  return createContentMap(
    intersectIdMapByIdSet(contentMap.inserts, contentIds.inserts),
    intersectIdMapByIdSet(contentMap.deletes, contentIds.deletes),
  );
}

function intersectIdMapByIdSet(idMap: IdMap, idSet: IdSet): IdMap {
  const result = new IdMap();
  for (const [client, ranges] of idMap.clients.entries()) {
    for (const range of ranges.getIds()) {
      const slices = idSet.slice(client, range.clock, range.len);
      for (const s of slices) {
        if (s.exists) {
          result.add(client, s.clock, s.len, range.attrs);
        }
      }
    }
  }
  return result;
}

/**
 * Create ContentIds from a ContentMap (discarding the attributes).
 */
export function createContentIdsFromContentMap(contentMap: ContentMap): ContentIds {
  const inserts = new IdSet();
  contentMap.inserts.forEach((client, clock, len) => {
    inserts.add(client, clock, len);
  });

  const deletes = new IdSet();
  contentMap.deletes.forEach((client, clock, len) => {
    deletes.add(client, clock, len);
  });

  return { inserts, deletes };
}
