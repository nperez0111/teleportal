import { describe, expect, it, beforeEach } from "bun:test";
import {
  AckMessage,
  DocMessage,
  AwarenessMessage,
  type ClientContext,
  type ServerContext,
  type StateVector,
} from "teleportal";
import { RpcMessage } from "teleportal/protocol";
import { TokenManager, createTokenManager } from "./index";
import { checkPermissionWithTokenManager } from "./check-permission";

describe("checkPermissionWithTokenManager", () => {
  let tokenManager: TokenManager;
  let checkPermission: (ctx: {
    context: ServerContext;
    documentId?: string;
    fileId?: string;
    message: any;
    type: "read" | "write";
  }) => Promise<boolean>;
  let context: ServerContext;

  beforeEach(() => {
    tokenManager = createTokenManager({
      secret: "test-secret-key-for-testing-only",
    });
    const permissionFn = checkPermissionWithTokenManager(tokenManager);
    if (!permissionFn) {
      throw new Error("checkPermissionWithTokenManager returned undefined");
    }
    checkPermission = permissionFn;
    context = {
      clientId: "client-1",
      userId: "user-1",
      room: "room-1",
    };
  });

  describe("ACK messages", () => {
    it("should allow ACK messages without permission checks", async () => {
      const ackMessage = new AckMessage(
        {
          type: "ack",
          messageId: "some-message-id",
        },
        context,
      );

      const result = await checkPermission({
        context,
        documentId: undefined,
        fileId: undefined,
        message: ackMessage,
        type: "read",
      });

      expect(result).toBe(true);
    });
  });

  describe("Awareness messages", () => {
    it("should allow awareness messages without permission checks", async () => {
      const awarenessMessage = new AwarenessMessage(
        "test-doc",
        {
          type: "awareness-update",
          update: new Uint8Array([1, 2, 3]) as any,
        },
        context,
      );

      const result = await checkPermission({
        context,
        documentId: "test-doc",
        fileId: undefined,
        message: awarenessMessage,
        type: "read",
      });

      expect(result).toBe(true);
    });
  });

  describe("RPC messages", () => {
    it("should allow RPC messages without permission checks", async () => {
      const rpcMessage = new RpcMessage(
        "test-doc",
        { type: "success", payload: { snapshotIds: [] } },
        "milestoneList",
        "request",
        undefined,
        context,
      );

      const result = await checkPermission({
        context,
        documentId: "test-doc",
        fileId: undefined,
        message: rpcMessage,
        type: "read",
      });

      expect(result).toBe(true);
    });

    it("should allow fileUpload RPC messages", async () => {
      const rpcMessage = new RpcMessage(
        "test-doc",
        {
          type: "success",
          payload: {
            fileId: "file-123",
            filename: "test.txt",
            size: 100,
            mimeType: "text/plain",
            lastModified: Date.now(),
            encrypted: false,
          },
        },
        "fileUpload",
        "request",
        undefined,
        context,
      );

      const result = await checkPermission({
        context,
        documentId: "test-doc",
        fileId: "file-123",
        message: rpcMessage,
        type: "write",
      });

      expect(result).toBe(true);
    });

    it("should allow fileDownload RPC messages", async () => {
      const rpcMessage = new RpcMessage(
        "test-doc",
        { type: "success", payload: { fileId: "file-123" } },
        "fileDownload",
        "request",
        undefined,
        context,
      );

      const result = await checkPermission({
        context,
        documentId: "test-doc",
        fileId: "file-123",
        message: rpcMessage,
        type: "read",
      });

      expect(result).toBe(true);
    });
  });

  describe("Doc messages - read permissions", () => {
    it("should check read permission for sync-step-1", async () => {
      const token = await tokenManager.createToken("user-1", "room-1", [
        { pattern: "test-doc", permissions: ["read"] },
      ]);

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const message = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { ...context, ...payload.payload } as ServerContext,
      );

      const result = await checkPermission({
        context: message.context,
        documentId: "test-doc",
        fileId: undefined,
        message,
        type: "read",
      });

      expect(result).toBe(true);
    });

    it("should deny read permission for sync-step-1 when user lacks access", async () => {
      const token = await tokenManager.createToken("user-1", "room-1", [
        { pattern: "other-doc", permissions: ["read"] },
      ]);

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const message = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { ...context, ...payload.payload } as ServerContext,
      );

      const result = await checkPermission({
        context: message.context,
        documentId: "test-doc",
        fileId: undefined,
        message,
        type: "read",
      });

      expect(result).toBe(false);
    });

    it("should check read permission for sync-done", async () => {
      const token = await tokenManager.createToken("user-1", "room-1", [
        { pattern: "test-doc", permissions: ["read"] },
      ]);

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const message = new DocMessage("test-doc", { type: "sync-done" }, {
        ...context,
        ...payload.payload,
      } as ServerContext);

      const result = await checkPermission({
        context: message.context,
        documentId: "test-doc",
        fileId: undefined,
        message,
        type: "read",
      });

      expect(result).toBe(true);
    });
  });

  describe("Doc messages - write permissions", () => {
    it("should check write permission for sync-step-2", async () => {
      const token = await tokenManager.createToken("user-1", "room-1", [
        { pattern: "test-doc", permissions: ["write"] },
      ]);

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const message = new DocMessage(
        "test-doc",
        {
          type: "sync-step-2",
          update: new Uint8Array([1, 2, 3]) as any,
        },
        { ...context, ...payload.payload } as ServerContext,
      );

      const result = await checkPermission({
        context: message.context,
        documentId: "test-doc",
        fileId: undefined,
        message,
        type: "write",
      });

      expect(result).toBe(true);
    });

    it("should deny write permission for sync-step-2 when user only has read", async () => {
      const token = await tokenManager.createToken("user-1", "room-1", [
        { pattern: "test-doc", permissions: ["read"] },
      ]);

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const message = new DocMessage(
        "test-doc",
        {
          type: "sync-step-2",
          update: new Uint8Array([1, 2, 3]) as any,
        },
        { ...context, ...payload.payload } as ServerContext,
      );

      const result = await checkPermission({
        context: message.context,
        documentId: "test-doc",
        fileId: undefined,
        message,
        type: "write",
      });

      expect(result).toBe(false);
    });

    it("should check write permission for update", async () => {
      const token = await tokenManager.createToken("user-1", "room-1", [
        { pattern: "test-doc", permissions: ["write"] },
      ]);

      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const message = new DocMessage(
        "test-doc",
        {
          type: "update",
          update: new Uint8Array([1, 2, 3]) as any,
        },
        { ...context, ...payload.payload } as ServerContext,
      );

      const result = await checkPermission({
        context: message.context,
        documentId: "test-doc",
        fileId: undefined,
        message,
        type: "write",
      });

      expect(result).toBe(true);
    });
  });

  describe("Doc messages - auth messages", () => {
    it("should deny auth-message", async () => {
      const message = new DocMessage(
        "test-doc",
        {
          type: "auth-message",
          permission: "denied",
          reason: "Test reason",
        },
        context,
      );

      const result = await checkPermission({
        context,
        documentId: "test-doc",
        fileId: undefined,
        message,
        type: "read",
      });

      expect(result).toBe(false);
    });
  });

  describe("RPC stream messages (file-parts)", () => {
    it("should allow RPC stream messages (file-parts)", async () => {
      const message = new RpcMessage<ServerContext>(
        "test-doc",
        {
          type: "success",
          payload: {
            fileId: "file-123",
            chunkIndex: 0,
            chunkData: new Uint8Array([1, 2, 3]),
            merkleProof: [],
            totalChunks: 1,
            bytesUploaded: 3,
            encrypted: false,
          },
        },
        "fileDownload",
        "stream",
        "original-request-id",
        context,
        false,
      );

      const result = await checkPermission({
        context,
        documentId: "test-doc",
        fileId: "file-123",
        message,
        type: "read",
      });

      expect(result).toBe(true);
    });
  });

  describe("Error handling", () => {
    it("should throw error when documentId is missing for doc messages", async () => {
      const message = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        context,
      );

      await expect(
        checkPermission({
          context,
          documentId: undefined,
          fileId: undefined,
          message,
          type: "read",
        }),
      ).rejects.toThrow("documentId is required for doc messages");
    });

    it("should throw error for unknown doc message payload types", async () => {
      const message = new DocMessage(
        "test-doc",
        {
          type: "unknown-type" as any,
        },
        context,
      );

      if (!checkPermission) {
        throw new Error("checkPermission not initialized");
      }

      await expect(
        checkPermission({
          context,
          documentId: "test-doc",
          fileId: undefined,
          message,
          type: "read",
        }),
      ).rejects.toThrow("Unknown doc message payload type");
    });
  });

  describe("Admin permissions", () => {
    it("should allow admin users to read", async () => {
      const token = await tokenManager.createAdminToken("user-1", "room-1");
      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const message = new DocMessage(
        "test-doc",
        {
          type: "sync-step-1",
          sv: new Uint8Array() as StateVector,
        },
        { ...context, ...payload.payload } as ServerContext,
      );

      if (!checkPermission) {
        throw new Error("checkPermission not initialized");
      }

      const result = await checkPermission({
        context: message.context,
        documentId: "test-doc",
        fileId: undefined,
        message,
        type: "read",
      });

      expect(result).toBe(true);
    });

    it("should allow admin users to write", async () => {
      const token = await tokenManager.createAdminToken("user-1", "room-1");
      const payload = await tokenManager.verifyToken(token);
      if (!payload.valid || !payload.payload) {
        throw new Error("Token verification failed");
      }

      const message = new DocMessage(
        "test-doc",
        {
          type: "update",
          update: new Uint8Array([1, 2, 3]) as any,
        },
        { ...context, ...payload.payload } as ServerContext,
      );

      if (!checkPermission) {
        throw new Error("checkPermission not initialized");
      }

      const result = await checkPermission({
        context: message.context,
        documentId: "test-doc",
        fileId: undefined,
        message,
        type: "write",
      });

      expect(result).toBe(true);
    });
  });
});
