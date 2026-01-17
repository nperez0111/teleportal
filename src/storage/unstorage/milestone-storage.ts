import { Milestone, type MilestoneSnapshot } from "teleportal";
import { uuidv4 } from "lib0/random";
import type { Storage } from "unstorage";
import type { Document, MilestoneStorage } from "../types";
import { withTransaction } from "./transaction";

/**
 * Unstorage storage for {@link Milestone}s
 */
export class UnstorageMilestoneStorage implements MilestoneStorage {
  readonly type = "milestone-storage" as const;
  // The strategy here is to have a metadata document and a milestone content document
  // This allows the list endpoint to be fast by not having to scan across keys
  private readonly storage: Storage;
  private readonly keyPrefix: string;
  private readonly ttl: number;

  constructor(
    storage: Storage,
    options?: {
      ttl?: number;
      keyPrefix?: string;
    },
  ) {
    this.storage = storage;
    this.keyPrefix = options?.keyPrefix ?? "milestone";
    this.ttl = options?.ttl ?? 5 * 1000;
  }

  /**
   * Lock a key for 5 seconds
   * @param key - The key to lock
   * @param cb - The callback to execute
   * @returns The TTL of the lock
   */
  async transaction<T>(
    key: string,
    cb: (key: string) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.storage, key, cb, { ttl: this.ttl });
  }

  #getMetadataKey(documentId: string) {
    return `${this.keyPrefix}:milestone:${documentId}:meta`;
  }

  #getContentKey(documentId: string, id: string) {
    return `${this.keyPrefix}:milestone:${documentId}:content:${id}`;
  }

  /**
   * Helper to get milestones without locking (assumes lock is held or not needed)
   */
  async #getMilestonesInternal(key: string): Promise<Milestone[]> {
    const milestoneMetaDoc = await this.storage.getItemRaw(key);
    if (!milestoneMetaDoc) {
      return [];
    }

    return Milestone.decodeMetaDoc(
      milestoneMetaDoc,
      this.getMilestoneSnapshot.bind(this),
    );
  }

  /**
   * Fetch all milestones for a document (without snapshot content loaded)
   */
  async getMilestones(
    documentId: Document["id"],
    options?: {
      includeDeleted?: boolean;
      lifecycleState?: Milestone["lifecycleState"];
    },
  ): Promise<Milestone[]> {
    return this.transaction(this.#getMetadataKey(documentId), async (key) => {
      let milestones = await this.#getMilestonesInternal(key);

      if (!options?.includeDeleted) {
        milestones = milestones.filter((m) => m.lifecycleState !== "deleted");
      }

      if (options?.lifecycleState) {
        milestones = milestones.filter(
          (m) => m.lifecycleState === options.lifecycleState,
        );
      }

      return milestones;
    });
  }

  /**
   * Fetch a specific milestone snapshot from storage
   */
  async getMilestoneSnapshot(
    documentId: Document["id"],
    id: Milestone["id"],
  ): Promise<MilestoneSnapshot> {
    const content = await this.storage.getItemRaw(
      this.#getContentKey(documentId, id),
    );

    if (!content) {
      throw new Error("failed to hydrate milestone", {
        cause: {
          documentId,
          id,
        },
      });
    }

    return Milestone.decode(content).fetchSnapshot();
  }

  /**
   * Create a new milestone in storage
   */
  async createMilestone(ctx: {
    name: string;
    documentId: Document["id"];
    createdAt: number;
    snapshot: MilestoneSnapshot;
    createdBy: { type: "user" | "system"; id: string };
  }): Promise<string> {
    const id = uuidv4();
    await this.transaction(
      this.#getMetadataKey(ctx.documentId),
      async (key) => {
        const milestones = await this.#getMilestonesInternal(key);

        const existingIndex = milestones.findIndex((m) => m.id === id);

        const milestone = new Milestone({ ...ctx, id });

        // If milestone exists, replace it; otherwise, append it
        if (existingIndex === -1) {
          milestones.push(milestone);
        } else {
          milestones[existingIndex] = milestone;
        }

        // Re-encode the metadata document with updated milestones
        const newMilestoneMetaDoc = Milestone.encodeMetaDoc(milestones);

        await Promise.all([
          this.storage.setItemRaw(
            this.#getContentKey(ctx.documentId, id),
            milestone.encode(),
          ),
          this.storage.setItemRaw(key, newMilestoneMetaDoc),
        ]);
      },
    );
    return id;
  }

  /**
   * Fetch a specific milestone from storage
   */
  async getMilestone(
    documentId: Document["id"],
    id: Milestone["id"],
  ): Promise<Milestone | null> {
    const milestones = await this.getMilestones(documentId);
    return milestones.find((milestone) => milestone.id === id) ?? null;
  }

  /**
   * Soft delete a milestone.
   */
  async deleteMilestone(
    documentId: Document["id"],
    id: Milestone["id"] | Milestone["id"][],
    deletedBy?: string,
  ): Promise<void> {
    const ids = ([] as string[]).concat(id as any);
    return this.transaction(this.#getMetadataKey(documentId), async (key) => {
      const milestones = await this.#getMilestonesInternal(key);
      let changed = false;
      const contentKeysToDelete: string[] = [];

      for (const targetId of ids) {
        const milestoneIndex = milestones.findIndex((m) => m.id === targetId);
        if (milestoneIndex === -1) continue;

        const milestone = milestones[milestoneIndex];
        if (milestone.lifecycleState !== "deleted") {
          // Soft delete
          milestone.lifecycleState = "deleted";
          milestone.deletedAt = Date.now();
          milestone.deletedBy = deletedBy;
          changed = true;
        } else {
          // Hard delete - remove from array and delete content
          milestones.splice(milestoneIndex, 1);
          contentKeysToDelete.push(this.#getContentKey(documentId, targetId));
          changed = true;
        }
      }

      if (changed) {
        await Promise.all([
          this.storage.setItemRaw(key, Milestone.encodeMetaDoc(milestones)),
          ...contentKeysToDelete.map((contentKey) =>
            this.storage.removeItem(contentKey),
          ),
        ]);
      }
    });
  }

  /**
   * Restore a soft-deleted milestone.
   */
  async restoreMilestone(
    documentId: Document["id"],
    id: Milestone["id"] | Milestone["id"][],
  ): Promise<void> {
    const ids = ([] as string[]).concat(id as any);
    return this.transaction(this.#getMetadataKey(documentId), async (key) => {
      const milestones = await this.#getMilestonesInternal(key);
      let changed = false;

      for (const targetId of ids) {
        const milestone = milestones.find((m) => m.id === targetId);
        if (milestone && milestone.lifecycleState === "deleted") {
          milestone.lifecycleState = "active";
          milestone.deletedAt = undefined;
          milestone.deletedBy = undefined;
          changed = true;
        }
      }

      if (changed) {
        await this.storage.setItemRaw(key, Milestone.encodeMetaDoc(milestones));
      }
    });
  }

  /**
   * Update the name of a milestone
   */
  async updateMilestoneName(
    documentId: Document["id"],
    id: Milestone["id"],
    name: string,
    createdBy?: { type: "user" | "system"; id: string },
  ): Promise<void> {
    return this.transaction(this.#getMetadataKey(documentId), async (key) => {
      const milestones = await this.#getMilestonesInternal(key);
      const milestoneIndex = milestones.findIndex((m) => m.id === id);
      if (milestoneIndex === -1) {
        throw new Error("Milestone not found", { cause: { documentId, id } });
      }

      const milestone = milestones[milestoneIndex];
      let updatedMilestone: Milestone;
      if (milestone.loaded) {
        const snapshot = await milestone.fetchSnapshot();
        updatedMilestone = new Milestone({
          ...milestone,
          name,
          createdBy: createdBy ?? milestone.createdBy,
          snapshot,
        });
      } else {
        updatedMilestone = new Milestone({
          ...milestone,
          name,
          createdBy: createdBy ?? milestone.createdBy,
          getSnapshot: milestone["getSnapshot"]!,
        });
      }

      milestones[milestoneIndex] = updatedMilestone;

      await this.storage.setItemRaw(key, Milestone.encodeMetaDoc(milestones));
    });
  }
}
