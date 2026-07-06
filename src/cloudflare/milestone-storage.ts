import { Milestone, type MilestoneSnapshot } from "teleportal";
import { uuidv4 } from "lib0/random";

import type { Document, MilestoneStorage } from "teleportal/storage";

import { type DurableObjectStorageLike, KeyedMutex } from "./types";

/**
 * Milestone storage backed directly by Durable Object storage.
 *
 * A metadata document (fast list operations) is stored separately from the
 * per-milestone content blobs (lazy snapshot loading). Snapshots are whole
 * document states, so a single milestone must fit the Durable Object
 * per-value limit (2 MiB for SQLite-backed objects).
 *
 * Storage layout:
 * - `{prefix}:milestone:{documentId}:meta`           -- encoded meta doc
 * - `{prefix}:milestone:{documentId}:content:{id}`   -- encoded milestone
 */
export class DurableObjectMilestoneStorage implements MilestoneStorage {
  readonly type = "milestone-storage" as const;

  readonly #storage: DurableObjectStorageLike;
  readonly #keyPrefix: string;
  readonly #mutex = new KeyedMutex();

  constructor(
    storage: DurableObjectStorageLike,
    options?: {
      keyPrefix?: string;
    },
  ) {
    this.#storage = storage;
    this.#keyPrefix = options?.keyPrefix ?? "milestone";
  }

  async transaction<T>(key: string, cb: (key: string) => Promise<T>): Promise<T> {
    return this.#mutex.run(key, () => cb(key));
  }

  #getMetadataKey(documentId: string) {
    return `${this.#keyPrefix}:milestone:${documentId}:meta`;
  }

  #getContentKey(documentId: string, id: string) {
    return `${this.#keyPrefix}:milestone:${documentId}:content:${id}`;
  }

  /**
   * Helper to get milestones without locking (assumes lock is held or not needed)
   */
  async #getMilestonesInternal(key: string): Promise<Milestone[]> {
    const milestoneMetaDoc = await this.#storage.get<Uint8Array>(key);
    if (!milestoneMetaDoc) {
      return [];
    }

    return Milestone.decodeMetaDoc(milestoneMetaDoc, this.getMilestoneSnapshot.bind(this));
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
        milestones = milestones.filter((m) => m.lifecycleState === options.lifecycleState);
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
    const content = await this.#storage.get<Uint8Array>(this.#getContentKey(documentId, id));

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
    await this.transaction(this.#getMetadataKey(ctx.documentId), async (key) => {
      const milestones = await this.#getMilestonesInternal(key);

      const milestone = new Milestone({ ...ctx, id });
      milestones.push(milestone);

      await Promise.all([
        this.#storage.put(this.#getContentKey(ctx.documentId, id), milestone.encode()),
        this.#storage.put(key, Milestone.encodeMetaDoc(milestones)),
      ]);
    });
    return id;
  }

  /**
   * Fetch a specific milestone from storage
   */
  async getMilestone(documentId: Document["id"], id: Milestone["id"]): Promise<Milestone | null> {
    const milestones = await this.getMilestones(documentId);
    return milestones.find((milestone) => milestone.id === id) ?? null;
  }

  /**
   * Soft delete a milestone; hard delete on the second call.
   */
  async deleteMilestone(
    documentId: Document["id"],
    id: Milestone["id"] | Milestone["id"][],
    deletedBy?: string,
  ): Promise<void> {
    const ids = ([] as string[]).concat(id);
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
          this.#storage.put(key, Milestone.encodeMetaDoc(milestones)),
          ...contentKeysToDelete.map((contentKey) => this.#storage.delete(contentKey)),
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
    const ids = ([] as string[]).concat(id);
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
        await this.#storage.put(key, Milestone.encodeMetaDoc(milestones));
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

      await this.#storage.put(key, Milestone.encodeMetaDoc(milestones));
    });
  }
}
