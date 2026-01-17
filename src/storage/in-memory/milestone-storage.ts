import { MilestoneSnapshot, Milestone } from "teleportal";
import { uuidv4 } from "lib0/random";
import type { Document, MilestoneStorage } from "../types";

/**
 * Naive in-memory storage for {@link Milestone}s
 */
export class InMemoryMilestoneStorage implements MilestoneStorage {
  readonly type = "milestone-storage" as const;
  public milestones = new Map<Milestone["id"], Milestone>();

  async getMilestones(
    documentId: Document["id"],
    options?: {
      includeDeleted?: boolean;
      lifecycleState?: Milestone["lifecycleState"];
    },
  ): Promise<Milestone[]> {
    let milestones = this.milestones
      .values()
      .filter((milestone) => milestone.documentId === documentId)
      .toArray();

    if (!options?.includeDeleted) {
      milestones = milestones.filter((m) => m.lifecycleState !== "deleted");
    }

    if (options?.lifecycleState) {
      milestones = milestones.filter(
        (m) => m.lifecycleState === options.lifecycleState,
      );
    }

    return milestones;
  }

  async createMilestone(ctx: {
    name: string;
    documentId: Document["id"];
    createdAt: number;
    snapshot: MilestoneSnapshot;
    createdBy: { type: "user" | "system"; id: string };
  }): Promise<string> {
    const id = uuidv4();
    this.milestones.set(id, new Milestone({ ...ctx, id }));
    return id;
  }

  async getMilestone(
    _documentId: Document["id"],
    id: Milestone["id"],
  ): Promise<Milestone | null> {
    const milestone = this.milestones.get(id);
    if (milestone && milestone.lifecycleState === "deleted") {
      return null;
    }
    return milestone || null;
  }

  async deleteMilestone(
    _documentId: Document["id"],
    id: Milestone["id"] | Milestone["id"][],
    deletedBy?: string,
  ): Promise<void> {
    const ids = ([] as string[]).concat(id as any);
    for (const i of ids) {
      const milestone = this.milestones.get(i);
      if (!milestone) continue;

      if (milestone.lifecycleState !== "deleted") {
        // Soft delete
        milestone.lifecycleState = "deleted";
        milestone.deletedAt = Date.now();
        milestone.deletedBy = deletedBy;
      } else {
        // Hard delete - remove from map
        this.milestones.delete(i);
      }
    }
  }

  async restoreMilestone(
    _documentId: Document["id"],
    id: Milestone["id"] | Milestone["id"][],
  ): Promise<void> {
    const ids = ([] as string[]).concat(id as any);
    for (const i of ids) {
      const milestone = this.milestones.get(i);
      if (milestone && milestone.lifecycleState === "deleted") {
        milestone.lifecycleState = "active";
        milestone.deletedAt = undefined;
        milestone.deletedBy = undefined;
      }
    }
  }

  async updateMilestoneName(
    _documentId: Document["id"],
    id: Milestone["id"],
    name: string,
    createdBy?: { type: "user" | "system"; id: string },
  ): Promise<void> {
    const milestone = this.milestones.get(id);
    if (!milestone) {
      throw new Error("Milestone not found", { cause: { id } });
    }
    if (milestone.loaded) {
      const snapshot = await milestone.fetchSnapshot();
      const updatedMilestone = new Milestone({
        ...milestone,
        name,
        createdBy: createdBy ?? milestone.createdBy,
        snapshot,
      });
      this.milestones.set(id, updatedMilestone);
    } else {
      const updatedMilestone = new Milestone({
        ...milestone,
        name,
        createdBy: createdBy ?? milestone.createdBy,
        getSnapshot: milestone["getSnapshot"]!,
      });
      this.milestones.set(id, updatedMilestone);
    }
  }

  async updateMilestoneRetention(
    _documentId: Document["id"],
    id: Milestone["id"],
    updates: {
      expiresAt?: number;
      lifecycleState?: Milestone["lifecycleState"];
      retentionPolicyId?: string;
    },
  ): Promise<void> {
    const milestone = this.milestones.get(id);
    if (!milestone) {
      throw new Error("Milestone not found", { cause: { id } });
    }

    if (updates.expiresAt !== undefined) {
      milestone.expiresAt = updates.expiresAt;
    }

    if (updates.lifecycleState !== undefined) {
      milestone.lifecycleState = updates.lifecycleState;
    }

    if (updates.retentionPolicyId !== undefined) {
      milestone.retentionPolicyId = updates.retentionPolicyId;
    }
  }
}
