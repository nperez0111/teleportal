/**
 * Extract ContentIds from Y.js v13 updates.
 *
 * Uses Y.decodeUpdateV2() / Y.decodeUpdate() to get the full struct and
 * delete-set data, then builds ContentIds with the same granularity as v14's
 * createContentIdsFromUpdate().
 *
 * When teleportal upgrades to v14, replace this with:
 *   import { createContentIdsFromUpdate } from '@y/y'
 */

import type { VersionedUpdate } from "teleportal";
import * as Y from "yjs";
import { type ContentIds, IdSet } from "./content-ids";

/**
 * Extract ContentIds (insert + delete ranges) from a versioned Y.js update.
 *
 * Dispatches to Y.decodeUpdate (V1) or Y.decodeUpdateV2 (V2) based on the
 * version field.
 */
export function createContentIdsFromUpdate(update: VersionedUpdate): ContentIds {
  const { structs, ds } =
    update.version === 1 ? Y.decodeUpdate(update.data) : Y.decodeUpdateV2(update.data);
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
  ds.clients.forEach((deleteItems: Array<{ clock: number; len: number }>, clientID: number) => {
    for (const item of deleteItems) {
      deletes.add(clientID, item.clock, item.len);
    }
  });

  return { inserts, deletes };
}
