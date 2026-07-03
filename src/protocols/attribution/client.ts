import * as Y from "yjs";
import { type MilestoneSnapshot } from "teleportal";
import {
  decodeContentEncryptedPayload,
  decryptContentPayload,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import {
  changesetContentMap,
  createContentIdsFromContentMap,
  createContentIdsFromUpdate,
  decodeContentMap,
  encodeContentIds,
  getActivity as getActivityFromMap,
  mergeContentMaps,
  milestoneContentMap,
  resolveItemAttribution,
  type ActivityEntry,
  type ContentIds,
  type ContentMap,
} from "teleportal/attribution";
import { createClientExtension } from "teleportal/rpc";
import type { MilestoneGetResponse } from "../milestone/methods";
import { resolveDeletedRangeAttribution, resolveRangeAttribution } from "./resolve";
import {
  attributionProtocol,
  type ActivityOptions,
  type AttributedSegment,
  type AttributionFilter,
} from "./methods";

export type AttributionRpc = {
  getActivity(options?: ActivityOptions): Promise<ActivityEntry[]>;
  getMap(filter?: AttributionFilter): Promise<ContentMap | null>;
  resolveItem(
    clientID: number,
    clock: number,
  ): Promise<{
    userId: string;
    timestamp: number;
    attributes: Record<string, unknown>;
  } | null>;
  getForRange(
    type: Y.AbstractType<any>,
    index: number,
    length: number,
  ): Promise<AttributedSegment[]>;
  /** Resolve who deleted content within a range. */
  getDeletedForRange(
    type: Y.AbstractType<any>,
    index: number,
    length: number,
  ): Promise<AttributedSegment[]>;
  /** Merge an incremental ContentMap into the local cache (e.g. from a push). */
  mergeIncremental(contentMap: ContentMap): void;
  invalidateCache(): void;
  getMilestoneContentMap(milestoneId: string): Promise<ContentMap | null>;
  getChangesetContentMap(
    fromMilestoneId: string,
    toMilestoneId: string,
  ): Promise<ContentMap | null>;
};

let activeInstance: { mergeIncremental: (map: ContentMap) => void } | null = null;

export const createAttributionRpc = createClientExtension(attributionProtocol, {
  destroy() {
    activeInstance = null;
  },

  handleMessage(message) {
    if (
      message.rpcMethod === "attributionPush" &&
      message.requestType === "response" &&
      message.payload?.type === "success"
    ) {
      const encoded = message.payload.payload?.contentMap;
      if (encoded && activeInstance) {
        activeInstance.mergeIncremental(decodeContentMap(encoded));
      }
      return true;
    }
    return false;
  },

  build(methods, ctx): AttributionRpc {
    let cachedMap: ContentMap | null | undefined;
    let cachedIds: ContentIds | undefined;

    function setCachedMap(map: ContentMap | null) {
      cachedMap = map;
      cachedIds = map ? createContentIdsFromContentMap(map) : undefined;
    }

    /**
     * Fetch and decode the attribution ContentMap, caching when unfiltered.
     */
    async function getMap(filter?: AttributionFilter): Promise<ContentMap | null> {
      const response = await methods.get(filter ? { filter } : {});
      const decoded = response.contentMap ? decodeContentMap(response.contentMap) : null;
      if (!filter) {
        setCachedMap(decoded);
      }
      return decoded;
    }

    /**
     * Ensure the cached ContentMap is loaded, fetching incrementally when
     * possible (only the ranges the client doesn't already have).
     */
    async function ensureMap(): Promise<ContentMap | null> {
      if (cachedMap === undefined) {
        await getMap();
        return cachedMap ?? null;
      }
      if (cachedMap && cachedIds) {
        const response = await methods.getIncremental({
          knownIds: encodeContentIds(cachedIds),
        });
        if (response.contentMap) {
          const diff = decodeContentMap(response.contentMap);
          const merged = mergeContentMaps([cachedMap, diff]);
          setCachedMap(merged);
        }
      }
      return cachedMap ?? null;
    }

    function mergeIncremental(incoming: ContentMap) {
      if (cachedMap) {
        setCachedMap(mergeContentMaps([cachedMap, incoming]));
      } else {
        setCachedMap(incoming);
      }
    }

    /**
     * Fetch and decrypt a milestone snapshot, returning its content IDs.
     */
    async function milestoneContentIds(milestoneId: string): Promise<ContentIds> {
      const response = await ctx.rpcClient.sendRequest<MilestoneGetResponse>(
        ctx.document,
        "milestoneGet",
        { milestoneId },
      );

      const snapshot = response.snapshot as unknown as Uint8Array;
      let plaintext: MilestoneSnapshot;

      if (!ctx.encryptionKey) {
        plaintext = snapshot as unknown as MilestoneSnapshot;
      } else {
        const payload = decodeContentEncryptedPayload(
          snapshot as unknown as EncryptedUpdatePayload,
        );
        plaintext = (await decryptContentPayload(
          ctx.encryptionKey,
          payload.structureUpdate,
          payload.encryptedSidecars,
          2,
        )) as unknown as MilestoneSnapshot;
      }

      return createContentIdsFromUpdate({
        version: 2,
        data: plaintext as any,
      });
    }

    /**
     * Attribution restricted to the content present in a milestone.
     * Computed client-side by intersecting the full ContentMap with
     * the milestone's operation IDs.
     */
    async function getMilestoneContentMap(milestoneId: string): Promise<ContentMap | null> {
      const [map, ids] = await Promise.all([ensureMap(), milestoneContentIds(milestoneId)]);
      if (!map) return null;
      return milestoneContentMap(map, ids);
    }

    /**
     * Attribution for the changes made between two milestones — the
     * operations added from `fromMilestoneId` to `toMilestoneId`.
     */
    async function getChangesetContentMap(
      fromMilestoneId: string,
      toMilestoneId: string,
    ): Promise<ContentMap | null> {
      const [map, fromIds, toIds] = await Promise.all([
        ensureMap(),
        milestoneContentIds(fromMilestoneId),
        milestoneContentIds(toMilestoneId),
      ]);
      if (!map) return null;
      return changesetContentMap(map, fromIds, toIds);
    }

    const api: AttributionRpc = {
      /**
       * Attribution activity timeline — who did what, when?
       *
       * Without `milestone` or `changeset`, the query runs server-side via
       * RPC. With milestone/changeset scoping, the ContentMap is fetched and
       * filtered client-side.
       */
      async getActivity(options?: ActivityOptions): Promise<ActivityEntry[]> {
        if (options?.milestone && options?.changeset) {
          throw new Error("getActivity: `milestone` and `changeset` are mutually exclusive");
        }
        if (options?.milestone || options?.changeset) {
          const map = options.milestone
            ? await getMilestoneContentMap(options.milestone)
            : await getChangesetContentMap(options.changeset![0], options.changeset![1]);
          if (!map) return [];
          return getActivityFromMap(map, options);
        }
        const response = await methods.activity({ ...options });
        return response.activity;
      },

      getMap,

      /**
       * Resolve who authored a specific Y.js item identified by
       * (clientID, clock). Uses the cached ContentMap, fetching it once
       * if not yet loaded.
       */
      async resolveItem(
        clientID: number,
        clock: number,
      ): Promise<{
        userId: string;
        timestamp: number;
        attributes: Record<string, unknown>;
      } | null> {
        const map = await ensureMap();
        if (!map) return null;
        return resolveItemAttribution(map, clientID, clock);
      },

      /**
       * Resolve attribution for a content range of a Y type (e.g. Y.Text),
       * mapping position range to CRDT operation IDs against the local
       * document, then looking them up in the cached ContentMap.
       */
      async getForRange(
        type: Y.AbstractType<any>,
        index: number,
        length: number,
      ): Promise<AttributedSegment[]> {
        const map = await ensureMap();
        if (!map) return [];
        return resolveRangeAttribution(type, index, length, map);
      },

      async getDeletedForRange(
        type: Y.AbstractType<any>,
        index: number,
        length: number,
      ): Promise<AttributedSegment[]> {
        const map = await ensureMap();
        if (!map) return [];
        return resolveDeletedRangeAttribution(type, index, length, map);
      },

      mergeIncremental,

      /**
       * Invalidate the cached attribution ContentMap. The next call to
       * resolveItem, getForRange, or any milestone method will re-fetch
       * from the server.
       */
      invalidateCache(): void {
        cachedMap = undefined;
        cachedIds = undefined;
      },

      getMilestoneContentMap,

      getChangesetContentMap,
    };

    activeInstance = api;
    return api;
  },
});
