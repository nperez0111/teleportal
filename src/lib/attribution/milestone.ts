/**
 * Milestone-scoped attribution.
 *
 * A milestone snapshot is a full Y.js update, so the operations *contained in*
 * a milestone are `createContentIdsFromUpdate(snapshot)` (see ./extract). These
 * helpers scope a document's full ContentMap to a milestone by intersecting it
 * with those operation IDs, and compute changesets by diffing two milestones'
 * IDs first.
 *
 * Pure composition over the set operations in ./content-ids and ./content-map —
 * no Y.js dependency. The Y.js snapshot -> ContentIds step happens at the call
 * site (the client), which is what keeps this E2EE-safe.
 */

import { type ContentIds, excludeContentIds } from "./content-ids";
import { type ContentMap, intersectContentMap } from "./content-map";

/**
 * Restrict a document's full attribution ContentMap to the operations present
 * in a milestone — i.e. who authored the content as of that milestone.
 */
export function milestoneContentMap(fullMap: ContentMap, milestoneIds: ContentIds): ContentMap {
  return intersectContentMap(fullMap, milestoneIds);
}

/**
 * Restrict a document's full attribution ContentMap to the operations added
 * between two milestones — i.e. who made the changes from `fromIds` to `toIds`.
 *
 * Covers both inserts and deletes introduced in the window, since
 * `createContentIdsFromUpdate` populates both halves of {@link ContentIds}.
 */
export function changesetContentMap(
  fullMap: ContentMap,
  fromIds: ContentIds,
  toIds: ContentIds,
): ContentMap {
  return intersectContentMap(fullMap, excludeContentIds(toIds, fromIds));
}
