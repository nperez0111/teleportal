/**
 * Extract ContentIds from Y.js v13 updates.
 *
 * Uses Y.decodeUpdateV2() to get the full struct and delete-set data,
 * then builds ContentIds with the same granularity as v14's
 * createContentIdsFromUpdate().
 *
 * When teleportal upgrades to v14, replace this with:
 *   import { createContentIdsFromUpdate } from '@y/y'
 */

import * as Y from "yjs";
import { type ContentIds, IdSet } from "./content-ids";

/**
 * Extract ContentIds (insert + delete ranges) from a Y.js v2-encoded update.
 *
 * Iterates the decoded structs to build insert ranges, accumulating
 * consecutive operations from the same client into single ranges
 * (same logic as v14's createContentIdsFromUpdateV2).
 *
 * GC and Skip structs are excluded — only Items count as inserts.
 */
export function createContentIdsFromUpdate(update: Uint8Array): ContentIds {
  const { structs, ds } = Y.decodeUpdateV2(update);
  const inserts = new IdSet();

  let lastClient = -1;
  let lastClock = 0;
  let lastLen = 0;

  for (const struct of structs) {
    if (struct instanceof Y.GC || struct instanceof Y.Skip) continue;
    const { client, clock } = struct.id;
    if (client === lastClient && clock === lastClock + lastLen) {
      lastLen += struct.length;
    } else {
      if (lastClient >= 0) {
        inserts.add(lastClient, lastClock, lastLen);
      }
      lastClient = client;
      lastClock = clock;
      lastLen = struct.length;
    }
  }
  if (lastClient >= 0) {
    inserts.add(lastClient, lastClock, lastLen);
  }

  const deletes = new IdSet();
  ds.clients.forEach(
    (deleteItems: Array<{ clock: number; len: number }>, clientID: number) => {
      for (const item of deleteItems) {
        deletes.add(clientID, item.clock, item.len);
      }
    },
  );

  return { inserts, deletes };
}
