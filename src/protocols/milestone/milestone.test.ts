import { describe, expect, it, beforeEach } from "bun:test";
import { getMilestoneRpcHandlers } from "./index";
import type { MilestoneStorage } from "teleportal/storage";

const createMockStorage = (): MilestoneStorage => {
  const storage: MilestoneStorage = {
    type: "milestone-storage",
    createMilestone: async () => "ms-new",
    getMilestone: async (docId, id) =>
      id === "ms-new"
        ? ({
            id: "ms-new",
            name: "new",
            documentId: docId,
            createdAt: Date.now(),
            createdBy: { type: "user" as const, id: "user-1" },
            fetchSnapshot: async () => new Uint8Array([1, 2, 3]) as any,
          } as any)
        : null,
    getMilestones: async () => [],
    deleteMilestone: async () => {},
    restoreMilestone: async () => {},
    updateMilestoneName: async () => {},
  };
  return storage;
};

const createTestContext = () => ({
  userId: "user-1",
  server: {} as any,
  documentId: "doc-1",
  session: {
    storage: {
      getDocumentMetadata: async () => ({
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: false,
        milestones: [],
      }),
      writeDocumentMetadata: async () => {},
      transaction: async (docId: string, cb: () => Promise<void>) => await cb(),
    } as any,
  } as any,
});

describe("Milestone RPC Methods", () => {
  describe("getMilestoneRpcHandlers", () => {
    it("should return RpcHandlerRegistry with init that returns cleanup", () => {
      const mockStorage = createMockStorage();
      const handlers = getMilestoneRpcHandlers(mockStorage);
      expect(typeof handlers).toBe("object");
      // The list handler should have an init that returns a cleanup function
      const listHandler = handlers["milestone.list"];
      expect(listHandler).toBeDefined();
      expect(typeof listHandler.init).toBe("function");
    });

    it("should register all milestone methods in handlers", () => {
      const mockStorage = createMockStorage();
      const handlers = getMilestoneRpcHandlers(mockStorage);
      expect("milestone.list" in handlers).toBe(true);
      expect("milestone.get" in handlers).toBe(true);
      expect("milestone.create" in handlers).toBe(true);
      expect("milestone.updateName" in handlers).toBe(true);
      expect("milestone.delete" in handlers).toBe(true);
      expect("milestone.restore" in handlers).toBe(true);
    });
  });

  describe("Handler execution", () => {
    let mockStorage: MilestoneStorage;
    let context: ReturnType<typeof createTestContext>;

    beforeEach(() => {
      mockStorage = createMockStorage();
      context = createTestContext();
    });

    it("should list milestones successfully", async () => {
      const mockMilestones = [
        {
          id: "ms-1",
          name: "v1.0",
          documentId: "doc-1",
          createdAt: Date.now(),
          createdBy: { type: "user" as const, id: "user-1" },
        },
      ];

      mockStorage.getMilestones = async () => mockMilestones as any;

      const handlers = getMilestoneRpcHandlers(mockStorage);
      const handler = handlers["milestone.list"];

      expect(handler).toBeDefined();

      const result = await handler!.handler!({ snapshotIds: [], includeDeleted: false }, context);

      expect(result.response).not.toHaveProperty("type", "error");
      const response = result.response as { milestones: unknown[] };
      expect(response.milestones).toEqual(mockMilestones);
    });

    it("should get milestone snapshot successfully", async () => {
      const snapshot = new Uint8Array([1, 2, 3]);
      const mockMilestone = {
        id: "ms-123",
        name: "v1.0",
        documentId: "doc-1",
        createdAt: Date.now(),
        createdBy: { type: "user" as const, id: "user-1" },
        fetchSnapshot: async () => snapshot as any,
      };

      mockStorage.getMilestone = async () => mockMilestone as any;

      const handlers = getMilestoneRpcHandlers(mockStorage);
      const handler = handlers["milestone.get"];

      const result = await handler!.handler!({ milestoneId: "ms-123" }, context);

      expect(result.response).not.toHaveProperty("type", "error");
      const response = result.response as {
        milestoneId: string;
        snapshot: Uint8Array;
      };
      expect(response.milestoneId).toBe("ms-123");
      expect(response.snapshot).toEqual(snapshot);
    });

    it("should return error when milestone not found", async () => {
      mockStorage.getMilestone = async () => null;

      const handlers = getMilestoneRpcHandlers(mockStorage);
      const handler = handlers["milestone.get"];

      const result = await handler!.handler!({ milestoneId: "ms-999" }, context);

      expect(result.response).toHaveProperty("type", "error");
      const response = result.response as { statusCode: number };
      expect(response.statusCode).toBe(404);
    });

    it("should create milestone successfully", async () => {
      const snapshot = new Uint8Array([1, 2, 3]);
      const newMilestone = {
        id: "ms-new",
        name: "v1.0",
        documentId: "doc-1",
        createdAt: Date.now(),
        createdBy: { type: "user" as const, id: "user-1" },
      };

      mockStorage.createMilestone = async () => "ms-new";
      mockStorage.getMilestone = async () => newMilestone as any;

      const handlers = getMilestoneRpcHandlers(mockStorage);
      const handler = handlers["milestone.create"];

      const result = await handler!.handler!({ name: "v1.0", snapshot }, context);

      expect(result.response).not.toHaveProperty("type", "error");
      const response = result.response as { milestone: { id: string } };
      expect(response.milestone.id).toBe("ms-new");
    });

    it("should update milestone name successfully", async () => {
      const updatedMilestone = {
        id: "ms-123",
        name: "v2.0",
        documentId: "doc-1",
        createdAt: Date.now(),
        createdBy: { type: "user" as const, id: "user-1" },
      };

      mockStorage.updateMilestoneName = async () => {};
      mockStorage.getMilestone = async () => updatedMilestone as any;

      const handlers = getMilestoneRpcHandlers(mockStorage);
      const handler = handlers["milestone.updateName"];

      const result = await handler!.handler!({ milestoneId: "ms-123", name: "v2.0" }, context);

      expect(result.response).not.toHaveProperty("type", "error");
      const response = result.response as { milestone: { name: string } };
      expect(response.milestone.name).toBe("v2.0");
    });

    it("should delete milestone successfully", async () => {
      mockStorage.deleteMilestone = async () => {};

      const handlers = getMilestoneRpcHandlers(mockStorage);
      const handler = handlers["milestone.delete"];

      const result = await handler!.handler!({ milestoneId: "ms-123" }, context);

      expect(result.response).not.toHaveProperty("type", "error");
      const response = result.response as { milestoneId: string };
      expect(response.milestoneId).toBe("ms-123");
    });

    it("should restore milestone successfully", async () => {
      const restoredMilestone = {
        id: "ms-123",
        name: "v1.0",
        documentId: "doc-1",
        createdAt: Date.now(),
        createdBy: { type: "user" as const, id: "user-1" },
      };

      mockStorage.restoreMilestone = async () => {};
      mockStorage.getMilestone = async () => restoredMilestone as any;

      const handlers = getMilestoneRpcHandlers(mockStorage);
      const handler = handlers["milestone.restore"];

      const result = await handler!.handler!({ milestoneId: "ms-123" }, context);

      expect(result.response).not.toHaveProperty("type", "error");
      const response = result.response as { milestone: { id: string } };
      expect(response.milestone.id).toBe("ms-123");
    });

    it("should handle storage errors for listMilestones", async () => {
      mockStorage.getMilestones = async () => {
        throw new Error("Storage error");
      };

      const handlers = getMilestoneRpcHandlers(mockStorage);
      const handler = handlers["milestone.list"];

      const result = await handler!.handler!({ snapshotIds: [], includeDeleted: false }, context);

      expect(result.response).toHaveProperty("type", "error");
      const response = result.response as { statusCode: number };
      expect(response.statusCode).toBe(500);
    });
  });
});
