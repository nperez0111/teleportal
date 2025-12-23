import { MilestoneSnapshot, Milestone } from "teleportal";
import { MilestoneStorage } from "../milestone-storage";

/**
 * Naive in-memory storage for {@link Milestone}s
 */
export class InMemoryMilestoneStorage implements MilestoneStorage {
  public milestones = new Map<Milestone["id"], Milestone>();

  async getMilestones(documentId: string): Promise<Milestone[]> {
    return this.milestones
      .values()
      .filter((milestone) => milestone.documentId === documentId)
      .toArray();
  }

  async createMilestone(ctx: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    snapshot: MilestoneSnapshot;
  }): Promise<void> {
    this.milestones.set(ctx.id, new Milestone(ctx));
  }

  async getMilestone(
    _documentId: string,
    id: string,
  ): Promise<Milestone | null> {
    return this.milestones.get(id) || null;
  }

  async deleteMilestone(
    _documentId: string,
    id: string | string[],
  ): Promise<void> {
    const ids = ([] as string[]).concat(id);
    ids.forEach((i) => {
      this.milestones.delete(i);
    });
  }
}
