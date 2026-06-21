import * as Y from "yjs";
import { type MilestoneSnapshot } from "teleportal";
import {
  decodeContentEncryptedPayload,
  decryptContentPayload,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import {
  changesetContentMap,
  createContentIdsFromUpdate,
  decodeContentMap,
  getActivity as getActivityFromMap,
  milestoneContentMap,
  resolveItemAttribution,
  type ActivityEntry,
  type ContentIds,
  type ContentMap,
} from "teleportal/attribution";
import type { RpcExtension, RpcExtensionContext } from "../../providers/rpc-extension";
import type { MilestoneGetResponse } from "../milestone/methods";
import { resolveRangeAttribution } from "./resolve";
import type {
  ActivityOptions,
  AttributedSegment,
  AttributionActivityResponse,
  AttributionFilter,
  AttributionGetResponse,
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
  invalidateCache(): void;
  getMilestoneContentMap(milestoneId: string): Promise<ContentMap | null>;
  getChangesetContentMap(
    fromMilestoneId: string,
    toMilestoneId: string,
  ): Promise<ContentMap | null>;
};

export function createAttributionRpc(): RpcExtension<AttributionRpc> {
  let cachedMap: ContentMap | null | undefined;

  return {
    create(ctx: RpcExtensionContext): AttributionRpc {
      /**
       * Fetch and decode the attribution ContentMap, caching when unfiltered.
       */
      async function getMap(filter?: AttributionFilter): Promise<ContentMap | null> {
        const response = await ctx.rpcClient.sendRequest<AttributionGetResponse>(
          ctx.document,
          "attributionGet",
          filter ? { filter } : {},
        );
        const decoded = response.contentMap ? decodeContentMap(response.contentMap) : null;
        if (!filter) {
          cachedMap = decoded;
        }
        return decoded;
      }

      /**
       * Ensure the cached ContentMap is loaded, fetching once if needed.
       */
      async function ensureMap(): Promise<ContentMap | null> {
        if (cachedMap === undefined) {
          await getMap();
        }
        return cachedMap ?? null;
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
          // For E2EE documents the snapshot is a content-encrypted payload
          // (structure update + encrypted sidecars). Decrypt it back into a
          // single plaintext Y.js update.
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

      return {
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
          const response = await ctx.rpcClient.sendRequest<AttributionActivityResponse>(
            ctx.document,
            "attributionActivity",
            { ...options },
          );
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

        /**
         * Invalidate the cached attribution ContentMap. The next call to
         * resolveItem, getForRange, or any milestone method will re-fetch
         * from the server.
         */
        invalidateCache(): void {
          cachedMap = undefined;
        },

        getMilestoneContentMap,

        getChangesetContentMap,
      };
    },

    destroy() {
      cachedMap = undefined;
    },
  };
}
