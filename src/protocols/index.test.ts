import { describe, expect, it } from "bun:test";
import { getMilestoneRpcHandlers, getFileRpcHandlers } from "./index";
import type { MilestoneStorage } from "teleportal/storage";

describe("protocols/index exports", () => {
  describe("milestone exports", () => {
    it("should export getMilestoneRpcHandlers", () => {
      expect(typeof getMilestoneRpcHandlers).toBe("function");
    });
  });

  describe("file exports", () => {
    it("should export getFileRpcHandlers", () => {
      expect(typeof getFileRpcHandlers).toBe("function");
    });
  });
});

describe("getMilestoneRpcHandlers factory", () => {
  it("should create handlers registry with milestone storage", () => {
    const mockStorage: MilestoneStorage = {
      type: "milestone-storage",
      createMilestone: async () => "ms-1",
      getMilestone: async () => null,
      getMilestones: async () => [],
      deleteMilestone: async () => {},
      restoreMilestone: async () => {},
      updateMilestoneName: async () => {},
    };
    const handlers = getMilestoneRpcHandlers(mockStorage);
    expect(handlers).toBeDefined();
    expect(typeof handlers).toBe("object");
    // Verify it has the milestone method handlers
    expect(handlers["milestoneList"]).toBeDefined();
  });
});

describe("getFileRpcHandlers factory", () => {
  it("should create handlers registry with file storage", () => {
    const mockStorage = {
      type: "file-storage" as const,
      uploadFile: async () => ({
        fileId: "file-1",
        parts: [],
      }),
      downloadFile: async () => ({
        fileId: "file-1",
        parts: [],
      }),
      deleteFile: async () => {},
      getFile: async () => null,
      checkUploadPermission: async () => ({ allowed: true }),
      checkDownloadPermission: async () => ({ allowed: true }),
    };
    const result = getFileRpcHandlers(mockStorage as any);
    expect(result).toBeDefined();
    expect("fileUpload" in result).toBe(true);
    expect("fileDownload" in result).toBe(true);
    expect(result["fileUpload"]).toHaveProperty("handler");
    expect(result["fileDownload"]).toHaveProperty("handler");
  });
});
