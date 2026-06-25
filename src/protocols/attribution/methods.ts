import { defineMethod, defineProtocol } from "teleportal/rpc";
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
  attributes?: Record<string, unknown>;
};

/**
 * Options for {@link Provider.getActivity}. Extends {@link AttributionFilter}
 * with optional milestone/changeset scoping — all filters compose with AND.
 */
export type ActivityOptions = AttributionFilter & {
  /** Scope to operations present in this milestone. */
  milestone?: string;
  /** Scope to operations added between two milestones: `[fromId, toId]`. */
  changeset?: [from: string, to: string];
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
  attributes: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Method contracts
// ---------------------------------------------------------------------------

export const attributionActivity = defineMethod<
  "attributionActivity",
  AttributionFilter,
  { activity: ActivityEntry[] }
>("attributionActivity");

export const attributionGet = defineMethod<
  "attributionGet",
  { filter?: AttributionFilter },
  { contentMap: EncodedContentMap | null }
>("attributionGet");

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

export const attributionProtocol = defineProtocol("attribution", {
  activity: attributionActivity,
  get: attributionGet,
});
