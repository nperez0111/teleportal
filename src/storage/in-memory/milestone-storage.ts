import { MilestoneSnapshot, Milestone } from "teleportal";
import { uuidv4 } from "lib0/random";
import type { Document, MilestoneStorage } from "../types";

/**
 * Naive in-memory storage for {@link Milestone}s
 */
export class InMemoryMilestoneStorage implements MilestoneStorage {
  readonly type = "milestone-storage" as const;
  public milestones = new Map<Milestone["id"], Milestone>();

  async getMilestones(documentId: Document["id"]): Promise<Milestone[]> {
    return this.milestones
      .values()
      .filter((milestone) => milestone.documentId === documentId)
      .toArray();
  }

  async createMilestone(ctx: {
    name: string;
    documentId: Document["id"];
    createdAt: number;
    snapshot: MilestoneSnapshot;
  }): Promise<string> {
    const id = uuidv4();
    this.milestones.set(id, new Milestone({ ...ctx, id }));
    return id;
  }

  async getMilestone(
    _documentId: Document["id"],
    id: Milestone["id"],
  ): Promise<Milestone | null> {
    return this.milestones.get(id) || null;
  }

  async deleteMilestone(
    _documentId: Document["id"],
    id: Milestone["id"] | Milestone["id"][],
  ): Promise<void> {
    const ids = ([] as string[]).concat(id);
    ids.forEach((i) => {
      this.milestones.delete(i);
    });
  }
}
