import { beforeEach, describe, expect, it } from "bun:test";
import { InMemoryMilestoneStorage } from "./milestone-storage";
import type { MilestoneSnapshot, StateVector, Update } from "teleportal";

describe("InMemoryMilestoneStorage", () => {
  const createTestSnapshot = (): MilestoneSnapshot => ({
    stateVector: new Uint8Array([1, 2, 3, 4, 5]) as StateVector,
    update: new Uint8Array([10, 20, 30, 40, 50]) as Update,
  });

  let storage: InMemoryMilestoneStorage;

  beforeEach(() => {
    storage = new InMemoryMilestoneStorage();
  });

  it("creates milestones and returns generated ids", async () => {
    const id = await storage.createMilestone({
      name: "v1.0.0",
      documentId: "doc-123",
      createdAt: 1234567890,
      snapshot: createTestSnapshot(),
    });

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const milestone = await storage.getMilestone("doc-123", id);
    expect(milestone).not.toBeNull();
    expect(milestone!.id).toBe(id);
    expect(milestone!.name).toBe("v1.0.0");
    expect(milestone!.documentId).toBe("doc-123");
  });

  it("lists milestones by document", async () => {
    const id1 = await storage.createMilestone({
      name: "v1",
      documentId: "doc-1",
      createdAt: 1,
      snapshot: createTestSnapshot(),
    });
    await storage.createMilestone({
      name: "v2",
      documentId: "doc-2",
      createdAt: 2,
      snapshot: createTestSnapshot(),
    });
    const id3 = await storage.createMilestone({
      name: "v3",
      documentId: "doc-1",
      createdAt: 3,
      snapshot: createTestSnapshot(),
    });

    const milestones = await storage.getMilestones("doc-1");
    const ids = milestones.map((m) => m.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id3);
    expect(milestones.every((m) => m.documentId === "doc-1")).toBe(true);
  });

  it("deletes milestones by id or id[]", async () => {
    const id1 = await storage.createMilestone({
      name: "v1",
      documentId: "doc-1",
      createdAt: 1,
      snapshot: createTestSnapshot(),
    });
    const id2 = await storage.createMilestone({
      name: "v2",
      documentId: "doc-1",
      createdAt: 2,
      snapshot: createTestSnapshot(),
    });

    await storage.deleteMilestone("doc-1", id1);
    expect(await storage.getMilestone("doc-1", id1)).toBeNull();
    expect(await storage.getMilestone("doc-1", id2)).not.toBeNull();

    await storage.deleteMilestone("doc-1", [id2]);
    expect(await storage.getMilestone("doc-1", id2)).toBeNull();
  });
});

