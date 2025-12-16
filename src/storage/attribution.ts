import * as Y from "yjs";
import type { Update } from "teleportal";
import type { AttributionMetadata } from "./document-storage";

const CUSTOM_ATTR_PREFIX = "attr:";

/**
 * Build an attribution IdMap for a Y.js update and attribution metadata.
 */
export function createAttributionIdMap(
  update: Update,
  metadata: AttributionMetadata,
): Y.IdMap<any> | null {
  try {
    const ranges = Y.readUpdateIdRanges(update);

    const insertAttributions = Y.createIdMapFromIdSet(ranges.inserts, [
      Y.createAttributionItem("insert", metadata.user),
      Y.createAttributionItem("insertAt", metadata.timestamp),
    ]);
    const deleteAttributions = Y.createIdMapFromIdSet(ranges.deletes, [
      Y.createAttributionItem("delete", metadata.user),
      Y.createAttributionItem("deleteAt", metadata.timestamp),
    ]);

    Y.insertIntoIdMap(insertAttributions, deleteAttributions);

    if (metadata.customAttributes) {
      const allChanges = Y.mergeIdSets([ranges.inserts, ranges.deletes]);
      const customItems = Object.entries(metadata.customAttributes).map(
        ([key, value]) =>
          Y.createAttributionItem(`${CUSTOM_ATTR_PREFIX}${key}`, value),
      );
      if (customItems.length > 0) {
        const customMap = Y.createIdMapFromIdSet(allChanges, customItems);
        Y.insertIntoIdMap(insertAttributions, customMap);
      }
    }

    return insertAttributions;
  } catch {
    return null;
  }
}
