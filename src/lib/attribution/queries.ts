/**
 * Query utilities for ContentMap attribution data.
 *
 * These provide the same capabilities as yhub's activity/changeset endpoints
 * but as pure functions over ContentMap.
 */

import { equalFlat } from "lib0/object";
import { type ContentMap, attrsToRecord, filterContentMap } from "./content-map";

export interface ActivityEntry {
  from: number;
  to: number;
  userId: string | null;
  attributes: Record<string, unknown>;
}

/**
 * Extract an activity timeline from a ContentMap.
 * Returns a sorted list of time ranges with the user who made changes.
 */
export function getActivity(
  contentMap: ContentMap,
  options?: {
    from?: number;
    to?: number;
    userId?: string;
    attributes?: Record<string, unknown>;
  },
): ActivityEntry[] {
  const filtered = filterContentMap(contentMap, (attrs) => {
    if (options?.from !== undefined || options?.to !== undefined) {
      const timeAttr = attrs.find((a) => a.name === "insertAt" || a.name === "deleteAt");
      if (timeAttr) {
        if (options.from !== undefined && (timeAttr.val as number) < options.from) return false;
        if (options.to !== undefined && (timeAttr.val as number) > options.to) return false;
      }
    }
    if (options?.userId !== undefined) {
      const userAttr = attrs.find((a) => a.name === "insert" || a.name === "delete");
      if (!userAttr || userAttr.val !== options.userId) return false;
    }
    if (options?.attributes) {
      for (const [name, val] of Object.entries(options.attributes)) {
        const attr = attrs.find((a) => a.name === name);
        if (!attr || attr.val !== val) return false;
      }
    }
    return true;
  });

  const activity: ActivityEntry[] = [];

  filtered.inserts.forEach((_client, _clock, _len, attrs) => {
    const timeAttr = attrs.find((a) => a.name === "insertAt");
    const userAttr = attrs.find((a) => a.name === "insert");
    if (timeAttr) {
      const t = timeAttr.val as number;
      activity.push({
        from: t,
        to: t,
        userId: userAttr ? (userAttr.val as string) : null,
        attributes: attrsToRecord(attrs),
      });
    }
  });

  filtered.deletes.forEach((_client, _clock, _len, attrs) => {
    const timeAttr = attrs.find((a) => a.name === "deleteAt");
    const userAttr = attrs.find((a) => a.name === "delete");
    if (timeAttr) {
      const t = timeAttr.val as number;
      activity.push({
        from: t,
        to: t,
        userId: userAttr ? (userAttr.val as string) : null,
        attributes: attrsToRecord(attrs),
      });
    }
  });

  activity.sort((a, b) => a.from - b.from);

  // Group adjacent entries from the same user within 1 second
  const grouped: ActivityEntry[] = [];
  for (const entry of activity) {
    const last = grouped.at(-1);
    if (
      last &&
      last.userId === entry.userId &&
      entry.from - last.to < 1000 &&
      equalFlat(last.attributes, entry.attributes)
    ) {
      last.to = entry.to;
    } else {
      grouped.push({ ...entry });
    }
  }

  return grouped;
}

/**
 * Resolve who authored a specific Y.js item identified by (clientID, clock).
 * Searches the ContentMap's insert ranges for a match.
 */
export function resolveItemAttribution(
  contentMap: ContentMap,
  clientID: number,
  clock: number,
): { userId: string; timestamp: number; attributes: Record<string, unknown> } | null {
  const ranges = contentMap.inserts.clients.get(clientID);
  if (!ranges) return null;

  for (const range of ranges.getIds()) {
    if (clock >= range.clock && clock < range.clock + range.len) {
      let userId: string | undefined;
      let timestamp: number | undefined;
      for (const attr of range.attrs) {
        if (attr.name === "insert") userId = attr.val as string;
        if (attr.name === "insertAt") timestamp = attr.val as number;
      }
      if (userId !== undefined && timestamp !== undefined) {
        return { userId, timestamp, attributes: attrsToRecord(range.attrs) };
      }
      return null;
    }
  }

  return null;
}
