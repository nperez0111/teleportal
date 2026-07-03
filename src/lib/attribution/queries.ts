/**
 * Query utilities for ContentMap attribution data.
 *
 * These provide the same capabilities as yhub's activity/changeset endpoints
 * but as pure functions over ContentMap.
 */

import { equalityDeep } from "lib0/function";
import { type ContentAttribute, type ContentMap, attrsToRecord } from "./content-map";

export interface ActivityEntry {
  from: number;
  to: number;
  userId: string | null;
  attributes: Record<string, unknown>;
}

/**
 * The built-in authorship attributes. These are compared via `userId` (insert/
 * delete) or are per-update timestamps (insertAt/deleteAt), so they are excluded
 * when deciding whether two adjacent activity entries can be grouped — otherwise
 * the differing timestamps would defeat the time-window merge below.
 */
const BUILTIN_ATTR_NAMES = new Set(["insert", "insertAt", "delete", "deleteAt"]);

function extractAttr(attrs: ContentAttribute[], name: string): unknown | undefined {
  for (let i = 0; i < attrs.length; i++) {
    if (attrs[i].name === name) return attrs[i].val;
  }
  return undefined;
}

function customAttrsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys: string[] = [];
  const bKeys: string[] = [];
  for (const k in a) if (!BUILTIN_ATTR_NAMES.has(k)) aKeys.push(k);
  for (const k in b) if (!BUILTIN_ATTR_NAMES.has(k)) bKeys.push(k);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!equalityDeep(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Check whether the given attrs pass the filter. Returns false if any
 * filter criterion fails.
 */
function passesFilter(
  attrs: ContentAttribute[],
  userAttrName: string,
  timeAttrName: string,
  from: number | undefined,
  to: number | undefined,
  userId: string | undefined,
  filterAttrs: Record<string, unknown> | undefined,
): boolean {
  if (userId !== undefined) {
    const val = extractAttr(attrs, userAttrName);
    if (val !== userId) return false;
  }
  if (from !== undefined || to !== undefined) {
    const val = extractAttr(attrs, timeAttrName);
    if (val !== undefined) {
      const t = val as number;
      if (from !== undefined && t < from) return false;
      if (to !== undefined && t > to) return false;
    }
  }
  if (filterAttrs) {
    for (const name in filterAttrs) {
      const val = extractAttr(attrs, name);
      if (val === undefined || !equalityDeep(val, filterAttrs[name])) return false;
    }
  }
  return true;
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
    /** Grouping window in milliseconds. Adjacent entries from the same user
     *  within this window are merged into a single entry. Defaults to 1000. */
    groupingWindowMs?: number;
  },
): ActivityEntry[] {
  const from = options?.from;
  const to = options?.to;
  const userId = options?.userId;
  const filterAttrs = options?.attributes;

  const activity: ActivityEntry[] = [];

  // Single pass over inserts — filter + extract in one go
  contentMap.inserts.forEach((_client, _clock, _len, attrs) => {
    if (!passesFilter(attrs, "insert", "insertAt", from, to, userId, filterAttrs)) return;
    const t = extractAttr(attrs, "insertAt") as number | undefined;
    if (t === undefined) return;
    const user = extractAttr(attrs, "insert");
    activity.push({
      from: t,
      to: t,
      userId: user !== undefined ? (user as string) : null,
      attributes: attrsToRecord(attrs),
    });
  });

  // Single pass over deletes
  contentMap.deletes.forEach((_client, _clock, _len, attrs) => {
    if (!passesFilter(attrs, "delete", "deleteAt", from, to, userId, filterAttrs)) return;
    const t = extractAttr(attrs, "deleteAt") as number | undefined;
    if (t === undefined) return;
    const user = extractAttr(attrs, "delete");
    activity.push({
      from: t,
      to: t,
      userId: user !== undefined ? (user as string) : null,
      attributes: attrsToRecord(attrs),
    });
  });

  activity.sort((a, b) => a.from - b.from);

  const windowMs = options?.groupingWindowMs ?? 1000;
  const grouped: ActivityEntry[] = [];
  for (const entry of activity) {
    const last = grouped.length > 0 ? grouped[grouped.length - 1] : undefined;
    if (
      last &&
      last.userId === entry.userId &&
      entry.from - last.to < windowMs &&
      customAttrsEqual(last.attributes, entry.attributes)
    ) {
      last.to = entry.to;
    } else {
      grouped.push(entry);
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

  const idx = ranges.findIndex(clock);
  if (idx < 0) return null;

  const range = ranges.getIds()[idx];
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
