import * as Y from "yjs";
import { Milestone, type MilestoneSnapshot } from "teleportal";
import {
  decodeContentEncryptedPayload,
  decryptContentPayload,
  encryptToContentPayload,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import { createClientExtension, RpcOperationError } from "teleportal/rpc";
import { milestoneProtocol, type MilestoneMetaFull } from "./methods";

/**
 * The public API surface exposed by the milestone RPC extension.
 */
export interface MilestoneRpc {
  list(options?: { includeDeleted?: boolean; snapshotIds?: string[] }): Promise<Milestone[]>;
  getSnapshot(milestoneId: string): Promise<MilestoneSnapshot>;
  create(name?: string): Promise<Milestone>;
  updateName(milestoneId: string, name: string): Promise<Milestone>;
  delete(milestoneId: string): Promise<void>;
  restore(milestoneId: string): Promise<Milestone>;
}

/**
 * Create a milestone RPC extension that adds milestone operations to the
 * provider's `rpc` namespace.
 *
 * @example
 * ```typescript
 * import { createMilestoneRpc } from "teleportal/protocols/milestone/client";
 * import { createEncryptionKey } from "teleportal/encryption-key";
 *
 * const provider = await Provider.create({
 *   url: "wss://...",
 *   document: "my-doc",
 *   encryptionKey: await createEncryptionKey(), // encrypted by default
 *   rpc: {
 *     milestones: createMilestoneRpc,
 *   },
 * });
 *
 * const milestones = await provider.rpc.milestones.list();
 * ```
 */
export const createMilestoneRpc = createClientExtension(milestoneProtocol, {
  build(methods, ctx): MilestoneRpc {
    const { doc, encryptionKey } = ctx;

    function createMilestoneFromMeta(meta: MilestoneMetaFull): Milestone {
      return new Milestone({
        id: meta.id,
        name: meta.name,
        documentId: meta.documentId,
        createdAt: meta.createdAt,
        deletedAt: meta.deletedAt,
        lifecycleState: meta.lifecycleState,
        expiresAt: meta.expiresAt,
        createdBy: meta.createdBy,
        getSnapshot: (_documentId: string, id: string) => api.getSnapshot(id),
      });
    }

    const api: MilestoneRpc = {
      async list(options) {
        const response = await methods.list({
          snapshotIds: options?.snapshotIds ?? [],
          includeDeleted: options?.includeDeleted ?? false,
        });
        return response.milestones.map((meta) => createMilestoneFromMeta(meta));
      },

      async getSnapshot(milestoneId) {
        const response = await methods.get({ milestoneId });

        const snapshot = response.snapshot as unknown as Uint8Array;
        if (!encryptionKey) {
          return snapshot as unknown as MilestoneSnapshot;
        }
        try {
          const payload = decodeContentEncryptedPayload(
            snapshot as unknown as EncryptedUpdatePayload,
          );
          return (await decryptContentPayload(
            encryptionKey,
            payload.structureUpdate,
            payload.encryptedSidecars,
            2,
          )) as unknown as MilestoneSnapshot;
        } catch (error) {
          throw new RpcOperationError("milestone", "decrypt milestone snapshot", error);
        }
      },

      async create(name?) {
        const plaintext = Y.encodeStateAsUpdateV2(doc);
        const snapshot = (encryptionKey
          ? await encryptToContentPayload(encryptionKey, plaintext)
          : plaintext) as unknown as MilestoneSnapshot;

        const response = await methods.create(
          { name, snapshot: snapshot as unknown as Uint8Array },
          { encrypted: !!encryptionKey },
        );
        return createMilestoneFromMeta(response.milestone as MilestoneMetaFull);
      },

      async updateName(milestoneId, name) {
        const response = await methods.updateName({ milestoneId, name });
        return createMilestoneFromMeta(response.milestone as MilestoneMetaFull);
      },

      async delete(milestoneId) {
        await methods.delete({ milestoneId });
      },

      async restore(milestoneId) {
        const response = await methods.restore({ milestoneId });
        return createMilestoneFromMeta(response.milestone);
      },
    };

    return api;
  },
});
