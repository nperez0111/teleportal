/**
 * Client-side range -> attribution resolution.
 *
 * Attribution is keyed by CRDT operation IDs (clientID, clock), but clients
 * think in terms of content positions (e.g. character offsets in a Y.Text).
 * These helpers map a position range to operation IDs by walking the local Y
 * type, then look those IDs up in a decoded ContentMap.
 *
 * This runs entirely against the local (decrypted) document, so it works
 * identically for encrypted and unencrypted documents — the server never needs
 * to resolve content positions.
 */

import { equalityDeep } from "lib0/function";
import type * as Y from "yjs";
import { attrsToRecord, type ContentMap } from "teleportal/attribution";
import type { AttributedSegment } from "./methods";

/**
 * A contiguous run of operation IDs from a single client, together with the
 * content offset at which the run begins in the queried type.
 */
export interface RangeId {
  client: number;
  clock: number;
  len: number;
  /** Content offset (in the queried type) corresponding to `clock`. */
  contentStart: number;
}

/**
 * Find the closest cached search marker to `index` and return the item + its
 * position. Falls back to `type._start` at position 0 when no markers exist.
 * Read-only — does not mutate the marker cache.
 */
function findNearestMarker(
  type: Y.AbstractType<any>,
  index: number,
): { item: Y.Item | null; pos: number } {
  const markers = (type as any)._searchMarker as
    | Array<{ p: Y.Item; index: number }>
    | null;
  if (!markers || markers.length === 0 || index === 0) {
    return { item: type._start, pos: 0 };
  }

  let best = markers[0];
  let bestDist = Math.abs(index - best.index);
  for (let i = 1; i < markers.length; i++) {
    const dist = Math.abs(index - markers[i].index);
    if (dist < bestDist) {
      best = markers[i];
      bestDist = dist;
    }
  }

  let item: Y.Item | null = best.p;
  let pos = best.index;

  // Walk right toward index
  while (item !== null && pos < index) {
    if (!item.deleted && item.countable) {
      if (index < pos + item.length) break;
      pos += item.length;
    }
    item = item.right;
  }

  // Walk left if we overshot
  while (item !== null && item.left !== null && pos > index) {
    item = item.left;
    if (!item.deleted && item.countable) {
      pos -= item.length;
    }
  }

  return { item, pos };
}

/**
 * Collect the operation IDs backing the content range `[index, index + length)`
 * of `type`. Deleted and non-countable items are skipped (they do not occupy a
 * content position), matching how Y.js computes the visible length.
 *
 * Uses Y.js's internal search markers when available to skip ahead instead of
 * always walking from `type._start`.
 */
export function collectRangeIds(
  type: Y.AbstractType<any>,
  index: number,
  length: number,
): RangeId[] {
  const ids: RangeId[] = [];
  const end = index + length;

  const { item: startItem, pos: startPos } = findNearestMarker(type, index);
  let pos = startPos;
  let item = startItem;

  while (item !== null && pos < end) {
    if (!item.deleted && item.countable) {
      const itemStart = pos;
      const itemEnd = pos + item.length;
      const overlapStart = Math.max(itemStart, index);
      const overlapEnd = Math.min(itemEnd, end);
      if (overlapStart < overlapEnd) {
        ids.push({
          client: item.id.client,
          clock: item.id.clock + (overlapStart - itemStart),
          len: overlapEnd - overlapStart,
          contentStart: overlapStart,
        });
      }
      pos = itemEnd;
    }
    item = item.right;
  }

  return ids;
}

/**
 * Collect the operation IDs of deleted items interspersed between visible
 * positions `[index, index + length)` in `type`. Each deleted item is
 * anchored to the visible position immediately before it (or `index` if
 * there is no preceding visible item in the range).
 */
export function collectDeletedRangeIds(
  type: Y.AbstractType<any>,
  index: number,
  length: number,
): RangeId[] {
  const ids: RangeId[] = [];
  const end = index + length;

  const { item: startItem, pos: startPos } = findNearestMarker(type, index);
  let pos = startPos;
  let item = startItem;

  // Walk to the start of the range
  while (item !== null && pos < index) {
    if (!item.deleted && item.countable) {
      pos += item.length;
    }
    if (pos <= index) item = item.right;
  }

  while (item !== null && pos <= end) {
    if (item.deleted && item.countable) {
      ids.push({
        client: item.id.client,
        clock: item.id.clock,
        len: item.length,
        contentStart: Math.min(pos, end),
      });
    } else if (!item.deleted && item.countable) {
      pos += item.length;
      if (pos > end) break;
    }
    item = item.right;
  }

  return ids;
}

function mergeSegments(segments: AttributedSegment[]): AttributedSegment[] {
  segments.sort((a, b) => a.from - b.from);
  const merged: AttributedSegment[] = [];
  for (const segment of segments) {
    const last = merged.at(-1);
    if (
      last &&
      last.to === segment.from &&
      last.userId === segment.userId &&
      last.timestamp === segment.timestamp &&
      equalityDeep(last.attributes, segment.attributes)
    ) {
      last.to = segment.to;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/**
 * Resolve attribution for the content range `[index, index + length)` of
 * `type` against `contentMap`, returning attributed segments in the content
 * coordinate space of `type`, sorted by `from` and merged across adjacent
 * same-author runs.
 *
 * Content with no matching attribution (e.g. inserted before attribution was
 * enabled) is omitted from the result.
 */
export function resolveRangeAttribution(
  type: Y.AbstractType<any>,
  index: number,
  length: number,
  contentMap: ContentMap,
): AttributedSegment[] {
  const segments: AttributedSegment[] = [];

  for (const id of collectRangeIds(type, index, length)) {
    const slices = contentMap.inserts.slice(id.client, id.clock, id.len);
    for (const slice of slices) {
      if (!slice.attrs) continue;

      const userAttr = slice.attrs.find((a) => a.name === "insert");
      const timeAttr = slice.attrs.find((a) => a.name === "insertAt");
      const from = id.contentStart + (slice.clock - id.clock);
      segments.push({
        from,
        to: from + slice.len,
        userId: userAttr ? String(userAttr.val) : null,
        timestamp: timeAttr ? Number(timeAttr.val) : null,
        attributes: attrsToRecord(slice.attrs),
      });
    }
  }

  return mergeSegments(segments);
}

/**
 * Resolve attribution for deleted content within `[index, index + length)`.
 * Returns segments anchored at the visible position where the deletion
 * occurred, with userId/timestamp from `contentMap.deletes`.
 */
export function resolveDeletedRangeAttribution(
  type: Y.AbstractType<any>,
  index: number,
  length: number,
  contentMap: ContentMap,
): AttributedSegment[] {
  const segments: AttributedSegment[] = [];

  for (const id of collectDeletedRangeIds(type, index, length)) {
    const slices = contentMap.deletes.slice(id.client, id.clock, id.len);
    for (const slice of slices) {
      if (!slice.attrs) continue;

      const userAttr = slice.attrs.find((a) => a.name === "delete");
      const timeAttr = slice.attrs.find((a) => a.name === "deleteAt");
      segments.push({
        from: id.contentStart,
        to: id.contentStart,
        userId: userAttr ? String(userAttr.val) : null,
        timestamp: timeAttr ? Number(timeAttr.val) : null,
        attributes: attrsToRecord(slice.attrs),
      });
    }
  }

  return mergeSegments(segments);
}
