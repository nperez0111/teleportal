import { Milestone, type MilestoneSnapshot } from "teleportal";
import { uuidv4 } from "lib0/random";
import type { Storage } from "unstorage";
import type { Document, MilestoneStorage } from "../types";

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
    const meta = await this.storage.getMeta(key);
    const lockedTTL = meta?.ttl;
    if (lockedTTL && lockedTTL > Date.now()) {
      // Wait for the lock to be released with jitter to avoid thundering herd
      const jitter = Math.random() * 1000; // Random delay between 0-1000ms
      const waitTime = lockedTTL - Date.now() + jitter;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return await this.transaction(key, cb);
    }
    const ttl = Date.now() + this.ttl;
    await this.storage.setMeta(key, { ttl, ...meta });
    const result = await cb(key);
    await this.storage.setMeta(key, { ttl: Date.now(), ...meta });
    return result;
  }

  #getMetadataKey(documentId: string) {
    return `${this.keyPrefix}:milestone:${documentId}:meta`;
  }

  #getContentKey(documentId: string, id: string) {
    return `${this.keyPrefix}:milestone:${documentId}:content:${id}`;
  }

  /**
   * Fetch all milestones for a document (without snapshot content loaded)
   */
  async getMilestones(documentId: Document["id"]): Promise<Milestone[]> {
    return this.transaction(this.#getMetadataKey(documentId), async (key) => {
      const milestoneMetaDoc = await this.storage.getItemRaw(key);
      if (!milestoneMetaDoc) {
        return [];
      }

      return Milestone.decodeMetaDoc(
        milestoneMetaDoc,
        this.getMilestoneSnapshot.bind(this),
      );
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
  }): Promise<string> {
    const id = uuidv4();
    await this.transaction(
      this.#getMetadataKey(ctx.documentId),
      async (key) => {
        const milestoneMetaDoc =
          ((await this.storage.getItemRaw(key)) as Uint8Array | null) ??
          new Uint8Array();

        // Decode existing milestones to check for duplicates
        const existingMilestones =
          milestoneMetaDoc.length > 0
            ? Milestone.decodeMetaDoc(
                milestoneMetaDoc,
                this.getMilestoneSnapshot.bind(this),
              )
            : [];

        // Ensure uniqueness of generated id (extremely unlikely to collide)
        const existingIndex = existingMilestones.findIndex((m) => m.id === id);

        const milestone = new Milestone({ ...ctx, id });

        // If milestone exists, replace it; otherwise, append it
        if (existingIndex >= 0) {
          existingMilestones[existingIndex] = milestone;
        } else {
          existingMilestones.push(milestone);
        }

        // Re-encode the metadata document with updated milestones
        const newMilestoneMetaDoc = Milestone.encodeMetaDoc(existingMilestones);

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
   * Delete the specified milestone(s) from storage
   */
  deleteMilestone(
    documentId: Document["id"],
    id: Milestone["id"] | Milestone["id"][],
  ): Promise<void> {
    const ids = ([] as string[]).concat(id as any);
    return this.transaction(this.#getMetadataKey(documentId), async (key) => {
      const milestones = await this.getMilestones(documentId);
      if (!milestones.some((milestone) => ids.includes(milestone.id))) {
        // bailing out early if the milestone ids are not found
        return;
      }
      await Promise.all(
        ids
          .map((id) =>
            // delete the content snapshots
            this.storage.removeItem(this.#getContentKey(documentId, id)),
          )
          .concat(
            // update the metadata
            this.storage.setItemRaw(
              key,
              Milestone.encodeMetaDoc(
                milestones.filter((milestone) => !ids.includes(milestone.id)),
              ),
            ),
          ),
      );
    });
  }
}
