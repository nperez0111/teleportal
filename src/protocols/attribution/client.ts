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
import { createClientExtension } from "teleportal/rpc";
import type { MilestoneGetResponse } from "../milestone/methods";
import { resolveRangeAttribution } from "./resolve";
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
  invalidateCache(): void;
  getMilestoneContentMap(milestoneId: string): Promise<ContentMap | null>;
  getChangesetContentMap(
    fromMilestoneId: string,
    toMilestoneId: string,
  ): Promise<ContentMap | null>;
};

export const createAttributionRpc = createClientExtension(attributionProtocol, {
  destroy() {
    // Handled by the extension instance lifecycle — cachedMap is scoped
    // per-build closure, so nothing to do here.
  },

  build(methods, ctx): AttributionRpc {
    let cachedMap: ContentMap | null | undefined;

    async function getMap(filter?: AttributionFilter): Promise<ContentMap | null> {
      const response = await methods.get(filter ? { filter } : {});
      const decoded = response.contentMap ? decodeContentMap(response.contentMap) : null;
      if (!filter) {
        cachedMap = decoded;
      }
      return decoded;
    }

    async function ensureMap(): Promise<ContentMap | null> {
      if (cachedMap === undefined) {
        await getMap();
      }
      return cachedMap ?? null;
    }

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

    async function getMilestoneContentMap(milestoneId: string): Promise<ContentMap | null> {
      const [map, ids] = await Promise.all([ensureMap(), milestoneContentIds(milestoneId)]);
      if (!map) return null;
      return milestoneContentMap(map, ids);
    }

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

      async getForRange(
        type: Y.AbstractType<any>,
        index: number,
        length: number,
      ): Promise<AttributedSegment[]> {
        const map = await ensureMap();
        if (!map) return [];
        return resolveRangeAttribution(type, index, length, map);
      },

      invalidateCache(): void {
        cachedMap = undefined;
      },

      getMilestoneContentMap,

      getChangesetContentMap,
    };
  },
});
