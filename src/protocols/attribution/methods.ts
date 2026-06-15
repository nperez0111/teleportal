import type { ActivityEntry } from "teleportal/attribution";
import type { EncodedContentMap } from "teleportal/storage";

/**
 * Filter applied to attribution data. All fields are optional and combine with
 * AND semantics. `from`/`to` are millisecond timestamps (inclusive).
 */
export type AttributionFilter = {
  userId?: string;
  from?: number;
  to?: number;
};

export type AttributionActivityRequest = AttributionFilter;

export type AttributionActivityResponse = {
  activity: ActivityEntry[];
};

export type AttributionGetRequest = {
  filter?: AttributionFilter;
};

export type AttributionGetResponse = {
  /**
   * The encoded ContentMap for the document, or null when the storage has no
   * attribution data (the storage does not support attribution, or none has
   * been recorded yet).
   */
  contentMap: EncodedContentMap | null;
};

/**
 * A resolved attribution segment over a content range, in the coordinate space
 * of the queried Y type (e.g. character offsets in a Y.Text).
 */
export type AttributedSegment = {
  from: number;
  to: number;
  userId: string | null;
  timestamp: number | null;
};
