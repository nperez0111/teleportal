import { describe, expect, it, beforeEach } from "bun:test";
import { getFileRpcHandlers } from "./index";
import type { FilePermissionOptions } from "./server-handlers";
import type { FileStorage } from "teleportal/storage";
import { InMemoryTemporaryUploadStorage } from "../../storage/in-memory/temporary-upload-storage";

const createMockStorage = (): FileStorage => {
  const storage: FileStorage = {
    type: "file-storage",
    getFile: async () => null,
    deleteFile: async () => {},
    storeFileFromUpload: async () => {},
  };
  storage.temporaryUploadStorage = new InMemoryTemporaryUploadStorage();
  return storage;
};

describe("File RPC Methods", () => {
  describe("getFileRpcHandlers", () => {
    it("should return a handler registry", () => {
      const mockStorage = createMockStorage();
      const registry = getFileRpcHandlers(mockStorage);
      expect(typeof registry).toBe("object");
      expect(registry).not.toBeInstanceOf(Map);
    });

    it("should register fileUpload method", () => {
      const mockStorage = createMockStorage();
      const registry = getFileRpcHandlers(mockStorage);
      expect("fileUpload" in registry).toBe(true);
    });

    it("should register fileDownload method", () => {
      const mockStorage = createMockStorage();
      const registry = getFileRpcHandlers(mockStorage);
      expect("fileDownload" in registry).toBe(true);
    });
  });

  describe("Handler execution", () => {
    let mockStorage: FileStorage;
    let context: ReturnType<typeof createTestContext>;

    const createTestContext = () => ({
      storage: mockStorage,
      documentId: "doc-1",
      server: {} as any,
      session: {} as any,
    });

    beforeEach(() => {
      mockStorage = createMockStorage();
      context = createTestContext();
    });

    describe("fileUpload handler", () => {
      it("should allow upload by default (no permission options)", async () => {
        const registry = getFileRpcHandlers(mockStorage);
        const handler = registry["fileUpload"];

        expect(handler).toBeDefined();

        const result = await handler!.handler(
          {
            fileId: "file-1",
            filename: "test.txt",
            size: 1024,
            mimeType: "text/plain",
            lastModified: Date.now(),
            encrypted: false,
          },
          context,
        );

        expect(result.response).not.toHaveProperty("type", "error");
        const response = result.response as {
          allowed: boolean;
          fileId: string;
        };
        expect(response.allowed).toBe(true);
        expect(response.fileId).toBe("file-1");
      });

      it("should allow upload when permission granted", async () => {
        const options: FilePermissionOptions = {
          checkUploadPermission: async () => ({ allowed: true }),
        };

        const registry = getFileRpcHandlers(mockStorage, options);
        const handler = registry["fileUpload"];

        const result = await handler!.handler(
          {
            fileId: "file-1",
            filename: "test.txt",
            size: 1024,
            mimeType: "text/plain",
            lastModified: Date.now(),
            encrypted: false,
          },
          context,
        );

        expect(result.response).not.toHaveProperty("type", "error");
        const response = result.response as {
          allowed: boolean;
          fileId: string;
        };
        expect(response.allowed).toBe(true);
        expect(response.fileId).toBe("file-1");
      });

      it("should deny upload when permission not granted", async () => {
        const options: FilePermissionOptions = {
          checkUploadPermission: async () => ({
            allowed: false,
            reason: "Storage quota exceeded",
          }),
        };

        const registry = getFileRpcHandlers(mockStorage, options);
        const handler = registry["fileUpload"];

        const result = await handler!.handler(
          {
            fileId: "file-1",
            filename: "test.txt",
            size: 1024,
            mimeType: "text/plain",
            lastModified: Date.now(),
            encrypted: false,
          },
          context,
        );

        expect(result.response).not.toHaveProperty("type", "error");
        const response = result.response as {
          allowed: boolean;
          reason?: string;
          statusCode?: number;
        };
        expect(response.allowed).toBe(false);
        expect(response.reason).toBe("Storage quota exceeded");
        expect(response.statusCode).toBe(403);
      });

      it("should handle permission check errors", async () => {
        const options: FilePermissionOptions = {
          checkUploadPermission: async () => {
            throw new Error("Permission check error");
          },
        };

        const registry = getFileRpcHandlers(mockStorage, options);
        const handler = registry["fileUpload"];

        const result = await handler!.handler(
          {
            fileId: "file-1",
            filename: "test.txt",
            size: 1024,
            mimeType: "text/plain",
            lastModified: Date.now(),
            encrypted: false,
          },
          context,
        );

        expect(result.response).toHaveProperty("type", "error");
        const response = result.response as { statusCode: number };
        expect(response.statusCode).toBe(500);
      });
    });

    describe("fileDownload handler", () => {
      it("should allow download by default (no permission options)", async () => {
        // Mock storage with a file
        const storageWithFile: FileStorage = {
          ...mockStorage,
          getFile: async (fileId: string) => {
            if (fileId === "file-1") {
              return {
                id: "file-1",
                chunks: [new Uint8Array([1, 2, 3])],
                contentId: new Uint8Array([1, 2, 3, 4]),
                metadata: {
                  filename: "test.txt",
                  size: 3,
                  mimeType: "text/plain",
                  lastModified: Date.now(),
                  encrypted: false,
                  documentId: "doc-1",
                },
              };
            }
            return null;
          },
        };
        const registry = getFileRpcHandlers(storageWithFile);
        const handler = registry["fileDownload"];

        const result = await handler!.handler({ fileId: "file-1" }, context);

        expect(result.response).not.toHaveProperty("type", "error");
        const response = result.response as {
          allowed: boolean;
          fileId: string;
        };
        expect(response.allowed).toBe(true);
        expect(response.fileId).toBe("file-1");
      });

      it("should allow download when permission granted with metadata", async () => {
        const options: FilePermissionOptions = {
          checkDownloadPermission: async () => ({
            allowed: true,
            metadata: {
              filename: "test.txt",
              size: 1024,
              mimeType: "text/plain",
              lastModified: Date.now(),
              encrypted: false,
            },
          }),
        };

        const registry = getFileRpcHandlers(mockStorage, options);
        const handler = registry["fileDownload"];

        const result = await handler!.handler({ fileId: "file-1" }, context);

        expect(result.response).not.toHaveProperty("type", "error");
        const response = result.response as {
          allowed: boolean;
          fileId: string;
          filename: string;
          size: number;
        };
        expect(response.allowed).toBe(true);
        expect(response.fileId).toBe("file-1");
        expect(response.filename).toBe("test.txt");
        expect(response.size).toBe(1024);
      });

      it("should deny download when permission not granted", async () => {
        const options: FilePermissionOptions = {
          checkDownloadPermission: async () => ({
            allowed: false,
            reason: "File not found",
          }),
        };

        const registry = getFileRpcHandlers(mockStorage, options);
        const handler = registry["fileDownload"];

        const result = await handler!.handler({ fileId: "file-999" }, context);

        expect(result.response).not.toHaveProperty("type", "error");
        const response = result.response as {
          allowed: boolean;
          reason?: string;
          statusCode?: number;
        };
        expect(response.allowed).toBe(false);
        expect(response.reason).toBe("File not found");
        expect(response.statusCode).toBe(404);
      });

      it("should handle permission check errors", async () => {
        const options: FilePermissionOptions = {
          checkDownloadPermission: async () => {
            throw new Error("Permission check error");
          },
        };

        const registry = getFileRpcHandlers(mockStorage, options);
        const handler = registry["fileDownload"];

        const result = await handler!.handler({ fileId: "file-1" }, context);

        expect(result.response).toHaveProperty("type", "error");
        const response = result.response as { statusCode: number };
        expect(response.statusCode).toBe(500);
      });
    });
  });
});
