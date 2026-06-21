import * as Y from "yjs";
import { Milestone, type MilestoneSnapshot } from "teleportal";
import {
  decodeContentEncryptedPayload,
  decryptContentPayload,
  encryptToContentPayload,
  type EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import { RpcOperationError } from "../../providers/rpc-client";
import type { RpcExtension, RpcExtensionContext } from "../../providers/rpc-extension";
import type {
  MilestoneListResponse,
  MilestoneGetResponse,
  MilestoneCreateResponse,
  MilestoneUpdateNameResponse,
  MilestoneDeleteResponse,
  MilestoneRestoreResponse,
} from "./methods";

/**
 * Error thrown when a milestone operation is denied
 */
export class MilestoneOperationDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(`Milestone operation denied: ${reason}`);
    this.name = "MilestoneOperationDeniedError";
  }
}

/**
 * Error thrown when a milestone operation fails
 */
export class MilestoneOperationError extends Error {
  constructor(
    public readonly operation: string,
    cause?: unknown,
  ) {
    const message =
      cause instanceof Error
        ? `Failed to ${operation}: ${cause.message}`
        : `Failed to ${operation}: ${String(cause)}`;
    super(message, { cause });
    this.name = "MilestoneOperationError";
  }
}

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
 *
 * const provider = await Provider.create({
 *   url: "wss://...",
 *   document: "my-doc",
 *   rpc: {
 *     milestones: createMilestoneRpc,
 *   },
 * });
 *
 * const milestones = await provider.rpc.milestones.list();
 * ```
 */
export function createMilestoneRpc(): RpcExtension<MilestoneRpc> {
  return {
    create(ctx: RpcExtensionContext): MilestoneRpc {
      const { rpcClient, document, doc, encryptionKey } = ctx;

      function createMilestoneFromMeta(meta: {
        id: string;
        name: string;
        documentId: string;
        createdAt: number;
        deletedAt?: number;
        lifecycleState?: "active" | "deleted" | "archived" | "expired";
        expiresAt?: number;
        createdBy: { type: "user" | "system"; id: string };
      }): Milestone {
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
        async list(options?: {
          includeDeleted?: boolean;
          snapshotIds?: string[];
        }): Promise<Milestone[]> {
          const snapshotIds = options?.snapshotIds ?? [];
          const includeDeleted = options?.includeDeleted ?? false;

          try {
            const response = await rpcClient.sendRequest<MilestoneListResponse>(
              document,
              "milestoneList",
              { snapshotIds, includeDeleted },
            );

            return response.milestones.map((meta) => createMilestoneFromMeta(meta));
          } catch (error) {
            if (error instanceof RpcOperationError) {
              throw new MilestoneOperationError("list milestones", error);
            }
            throw error;
          }
        },

        async getSnapshot(milestoneId: string): Promise<MilestoneSnapshot> {
          try {
            const response = await rpcClient.sendRequest<MilestoneGetResponse>(
              document,
              "milestoneGet",
              { milestoneId },
            );

            const snapshot = response.snapshot as unknown as Uint8Array;
            if (!encryptionKey) {
              return snapshot as unknown as MilestoneSnapshot;
            }
            // For E2EE documents the snapshot is a content-encrypted payload
            // (structure update + encrypted sidecars). The server uses the same
            // format for automatic milestones, so getSnapshot can decrypt both
            // uniformly back into a single plaintext Y.js update.
            const payload = decodeContentEncryptedPayload(
              snapshot as unknown as EncryptedUpdatePayload,
            );
            const plaintext = await decryptContentPayload(
              encryptionKey,
              payload.structureUpdate,
              payload.encryptedSidecars,
              2,
            );
            return plaintext as unknown as MilestoneSnapshot;
          } catch (error) {
            if (error instanceof RpcOperationError) {
              throw new MilestoneOperationError("get milestone snapshot", error);
            }
            throw error;
          }
        },

        async create(name?: string): Promise<Milestone> {
          const plaintext = Y.encodeStateAsUpdateV2(doc);
          // For E2EE documents, encrypt the snapshot before it leaves the client so
          // milestone content is never stored in plaintext on the server. It uses the
          // same content-encrypted payload format the server uses for automatic
          // milestones, so getSnapshot can decrypt both uniformly.
          const snapshot = (
            encryptionKey
              ? await encryptToContentPayload(encryptionKey, plaintext)
              : plaintext
          ) as unknown as MilestoneSnapshot;

          try {
            const response = await rpcClient.sendRequest<MilestoneCreateResponse>(
              document,
              "milestoneCreate",
              { name, snapshot },
              { encrypted: !!encryptionKey },
            );

            return createMilestoneFromMeta(response.milestone);
          } catch (error) {
            if (error instanceof RpcOperationError) {
              throw new MilestoneOperationError("create milestone", error);
            }
            throw error;
          }
        },

        async updateName(milestoneId: string, name: string): Promise<Milestone> {
          try {
            const response = await rpcClient.sendRequest<MilestoneUpdateNameResponse>(
              document,
              "milestoneUpdateName",
              { milestoneId, name },
            );

            return createMilestoneFromMeta(response.milestone);
          } catch (error) {
            if (error instanceof RpcOperationError) {
              throw new MilestoneOperationError("update milestone name", error);
            }
            throw error;
          }
        },

        async delete(milestoneId: string): Promise<void> {
          try {
            await rpcClient.sendRequest<MilestoneDeleteResponse>(document, "milestoneDelete", {
              milestoneId,
            });
          } catch (error) {
            if (error instanceof RpcOperationError) {
              throw new MilestoneOperationError("delete milestone", error);
            }
            throw error;
          }
        },

        async restore(milestoneId: string): Promise<Milestone> {
          try {
            const response = await rpcClient.sendRequest<MilestoneRestoreResponse>(
              document,
              "milestoneRestore",
              { milestoneId },
            );

            return createMilestoneFromMeta(response.milestone);
          } catch (error) {
            if (error instanceof RpcOperationError) {
              throw new MilestoneOperationError("restore milestone", error);
            }
            throw error;
          }
        },
      };

      return api;
    },
  };
}
