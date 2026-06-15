/**
 * Query utilities for ContentMap attribution data.
 *
 * These provide the same capabilities as yhub's activity/changeset endpoints
 * but as pure functions over ContentMap.
 */

import { type ContentMap, filterContentMap } from "./content-map";

export interface ActivityEntry {
  from: number;
  to: number;
  userId: string | null;
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
      });
    }
  });

  activity.sort((a, b) => a.from - b.from);

  // Group adjacent entries from the same user within 1 second
  const grouped: ActivityEntry[] = [];
  for (const entry of activity) {
    const last = grouped.at(-1);
    if (last && last.userId === entry.userId && entry.from - last.to < 1000) {
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
): { userId: string; timestamp: number } | null {
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
        return { userId, timestamp };
      }
      return null;
    }
  }

  return null;
}
