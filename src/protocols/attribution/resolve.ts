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
 * Collect the operation IDs backing the content range `[index, index + length)`
 * of `type`. Deleted and non-countable items are skipped (they do not occupy a
 * content position), matching how Y.js computes the visible length.
 */
export function collectRangeIds(
  type: Y.AbstractType<any>,
  index: number,
  length: number,
): RangeId[] {
  const ids: RangeId[] = [];
  const end = index + length;
  let pos = 0;
  let item = type._start;

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
    const ranges = contentMap.inserts.clients.get(id.client);
    if (!ranges) continue;

    const idEnd = id.clock + id.len;
    for (const range of ranges.getIds()) {
      const overlapStart = Math.max(range.clock, id.clock);
      const overlapEnd = Math.min(range.clock + range.len, idEnd);
      if (overlapStart >= overlapEnd) continue;

      const userAttr = range.attrs.find((a) => a.name === "insert");
      const timeAttr = range.attrs.find((a) => a.name === "insertAt");
      const from = id.contentStart + (overlapStart - id.clock);
      segments.push({
        from,
        to: from + (overlapEnd - overlapStart),
        userId: userAttr ? String(userAttr.val) : null,
        timestamp: timeAttr ? Number(timeAttr.val) : null,
        attributes: attrsToRecord(range.attrs),
      });
    }
  }

  segments.sort((a, b) => a.from - b.from);

  // Merge adjacent segments from the same author.
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
