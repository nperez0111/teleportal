import { MilestoneSnapshot, Milestone } from "teleportal";
import { uuidv4 } from "lib0/random";
import { MilestoneStorage } from "../types";

/**
 * Naive in-memory storage for {@link Milestone}s
 */
export class InMemoryMilestoneStorage implements MilestoneStorage {
  readonly type = "milestone-storage";
  public milestones = new Map<Milestone["id"], Milestone>();

  async getMilestones(documentId: string): Promise<Milestone[]> {
    return Array.from(this.milestones.values()).filter(
      (milestone) => milestone.documentId === documentId,
    );
  }

  async createMilestone(ctx: {
    name: string;
    documentId: string;
    createdAt: number;
    snapshot: MilestoneSnapshot;
  }): Promise<string> {
    const id = uuidv4();
    this.milestones.set(id, new Milestone({ ...ctx, id }));
    return id;
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
