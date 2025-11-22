import { describe, expect, it } from "bun:test";
import { fromBase64, toBase64 } from "lib0/buffer";
import {
  AckMessage,
  FileMessage,
  ServerContext,
  type Message,
} from "teleportal";
import {
  buildMerkleTree,
  CHUNK_SIZE,
  generateMerkleProof,
} from "../lib/merkle-tree/merkle-tree";
import { InMemoryFileStorage } from "../storage/in-memory/file-storage";
import { FileHandler } from "./file-handler";
import { augmentLogger } from "./logger";
import { getLogger } from "@logtape/logtape";

const emptyLogger = augmentLogger(
  getLogger(["teleportal", "tests", "file-handler-test"]),
);

describe("FileHandler", () => {
  it("should handle file upload request and authorize it", async () => {
    const fileStorage = new InMemoryFileStorage();
    const fileHandler = new FileHandler(fileStorage, emptyLogger);

    const sentMessages: Message<ServerContext>[] = [];
    const sendResponse = async (message: Message<ServerContext>) => {
      sentMessages.push(message);
    };

    // Client sends file-upload message
    const uploadMessage = new FileMessage<ServerContext>("test-doc", {
      type: "file-upload",
      fileId: "test-upload-id",
      filename: "test.txt",
      size: 5,
      mimeType: "text/plain",
      lastModified: Date.now(),
      encrypted: false,
    });

    // let it be processed async
    await fileHandler.handle(uploadMessage, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should receive file-download message (authorization)
    expect(sentMessages.length).toBe(1);
    const authMessage = sentMessages[0] as FileMessage<ServerContext>;
    expect(authMessage.payload.type).toBe("file-download");
    expect((authMessage.payload as any).fileId).toBe("test-upload-id");
    sentMessages.shift();

    // Check that upload session was initiated
    const uploadProgress = await fileStorage.getUploadProgress("test-upload-id");
    expect(uploadProgress).not.toBeNull();
    expect(uploadProgress!.metadata.filename).toBe("test.txt");
    expect(uploadProgress!.metadata.size).toBe(5);
  });

  it("should handle file-part message and send ack", async () => {
    const fileStorage = new InMemoryFileStorage();
    const fileHandler = new FileHandler(fileStorage, emptyLogger);

    // First, initiate the upload with a multi-chunk file so we can check progress before completion
    const fileData1 = new Uint8Array(CHUNK_SIZE);
    fileData1.fill(1);
    const fileData2 = new Uint8Array(100);
    fileData2.fill(2);
    const totalSize = fileData1.length + fileData2.length;

    await fileStorage.initiateUpload("test-upload-id", {
      filename: "test.txt",
      size: totalSize,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    const sentMessages: Message<ServerContext>[] = [];
    const sendResponse = async (message: Message<ServerContext>) => {
      sentMessages.push(message);
    };

    // Build merkle tree for the file
    const chunks = [fileData1, fileData2];
    const merkleTree = buildMerkleTree(chunks);
    const proof = generateMerkleProof(merkleTree, 0);

    // Client sends first file-part message
    const partMessage = new FileMessage<ServerContext>("test-doc", {
      type: "file-part",
      fileId: "test-upload-id",
      chunkIndex: 0,
      chunkData: fileData1,
      merkleProof: proof,
      totalChunks: 2,
      bytesUploaded: fileData1.length,
      encrypted: false,
    });

    // let it be processed async
    await fileHandler.handle(partMessage, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should receive ack message
    expect(sentMessages.length).toBe(1);
    const ackMessage = sentMessages[0] as AckMessage<ServerContext>;
    expect(ackMessage.payload.type).toBe("ack");
    expect(ackMessage.payload.messageId).toBe(partMessage.id);
    sentMessages.shift();

    // Check that chunk was stored (upload not complete yet, so session still exists)
    const uploadProgress = await fileStorage.getUploadProgress("test-upload-id");
    expect(uploadProgress).not.toBeNull();
    expect(uploadProgress!.chunks.has(0)).toBe(true);
    expect(uploadProgress!.chunks.get(0)).toEqual(fileData1);
  });

  it("should complete upload when all chunks are received", async () => {
    const fileStorage = new InMemoryFileStorage();
    const fileHandler = new FileHandler(fileStorage, emptyLogger);

    // First, initiate the upload
    const fileData = new Uint8Array([1, 2, 3, 4, 5]);
    await fileStorage.initiateUpload("test-upload-id", {
      filename: "test.txt",
      size: 5,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    const sentMessages: Message<ServerContext>[] = [];
    const sendResponse = async (message: Message<ServerContext>) => {
      sentMessages.push(message);
    };

    // Build merkle tree for the file
    const merkleTree = buildMerkleTree([fileData]);
    const proof = generateMerkleProof(merkleTree, 0);
    const contentId = toBase64(
      merkleTree.nodes[merkleTree.nodes.length - 1].hash,
    );

    // Client sends file-part message (the only chunk)
    const partMessage = new FileMessage<ServerContext>("test-doc", {
      type: "file-part",
      fileId: "test-upload-id",
      chunkIndex: 0,
      chunkData: fileData,
      merkleProof: proof,
      totalChunks: 1,
      bytesUploaded: 5,
      encrypted: false,
    });

    // let it be processed async
    await fileHandler.handle(partMessage, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should receive ack message
    expect(sentMessages.length).toBe(1);
    const ackMessage = sentMessages[0] as AckMessage<ServerContext>;
    expect(ackMessage.payload.type).toBe("ack");
    sentMessages.shift();

    // Check that file was completed and stored
    const contentIdBytes = fromBase64(contentId);
    const storedFile = await fileStorage.getFile(contentIdBytes);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.metadata.filename).toBe("test.txt");
    expect(storedFile!.metadata.size).toBe(5);
  });

  it("should handle multi-chunk upload", async () => {
    const fileStorage = new InMemoryFileStorage();
    const fileHandler = new FileHandler(fileStorage, emptyLogger);

    // Create a file larger than one chunk
    const largeFileData = new Uint8Array(CHUNK_SIZE + 100);
    largeFileData.fill(42);
    const totalSize = largeFileData.length;

    await fileStorage.initiateUpload("large-upload-id", {
      filename: "large.txt",
      size: totalSize,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    const sentMessages: Message<ServerContext>[] = [];
    const sendResponse = async (message: Message<ServerContext>) => {
      sentMessages.push(message);
    };

    // Build merkle tree for the file
    const chunks = [
      largeFileData.slice(0, CHUNK_SIZE),
      largeFileData.slice(CHUNK_SIZE),
    ];
    const merkleTree = buildMerkleTree(chunks);

    // Client sends first file-part message
    const part1Message = new FileMessage<ServerContext>("test-doc", {
      type: "file-part",
      fileId: "large-upload-id",
      chunkIndex: 0,
      chunkData: chunks[0],
      merkleProof: generateMerkleProof(merkleTree, 0),
      totalChunks: 2,
      bytesUploaded: CHUNK_SIZE,
      encrypted: false,
    });

    // let it be processed async
    await fileHandler.handle(part1Message, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should receive ack message
    expect(sentMessages.length).toBe(1);
    const ack1Message = sentMessages[0] as AckMessage<ServerContext>;
    expect(ack1Message.payload.type).toBe("ack");
    sentMessages.shift();

    // Client sends second file-part message
    const part2Message = new FileMessage<ServerContext>("test-doc", {
      type: "file-part",
      fileId: "large-upload-id",
      chunkIndex: 1,
      chunkData: chunks[1],
      merkleProof: generateMerkleProof(merkleTree, 1),
      totalChunks: 2,
      bytesUploaded: totalSize,
      encrypted: false,
    });

    // let it be processed async
    await fileHandler.handle(part2Message, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should receive ack message
    expect(sentMessages.length).toBe(1);
    const ack2Message = sentMessages[0] as AckMessage<ServerContext>;
    expect(ack2Message.payload.type).toBe("ack");
    sentMessages.shift();

    // Check that file was completed and stored
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;
    const storedFile = await fileStorage.getFile(contentId);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.metadata.filename).toBe("large.txt");
    expect(storedFile!.metadata.size).toBe(totalSize);
  });

  it("should handle download request and send file", async () => {
    const fileStorage = new InMemoryFileStorage();
    const fileHandler = new FileHandler(fileStorage, emptyLogger);

    // First, store a file
    const fileData = new Uint8Array([1, 2, 3, 4, 5]);
    const merkleTree = buildMerkleTree([fileData]);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;
    const contentIdBase64 = toBase64(contentId);

    // Complete an upload to store the file
    await fileStorage.initiateUpload("upload-id", {
      filename: "stored.txt",
      size: 5,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });
    await fileStorage.storeChunk("upload-id", 0, fileData, []);
    await fileStorage.completeUpload("upload-id", contentId);

    const sentMessages: Message<ServerContext>[] = [];
    const sendResponse = async (message: Message<ServerContext>) => {
      sentMessages.push(message);
    };

    // Client sends file-download request
    const downloadMessage = new FileMessage<ServerContext>("test-doc", {
      type: "file-download",
      fileId: contentIdBase64,
    });

    // let it be processed async
    await fileHandler.handle(downloadMessage, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should receive file-upload message (metadata)
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const metadataMessage = sentMessages[0] as FileMessage<ServerContext>;
    expect(metadataMessage.payload.type).toBe("file-upload");
    expect((metadataMessage.payload as any).filename).toBe("stored.txt");
    expect((metadataMessage.payload as any).size).toBe(5);
    sentMessages.shift();

    // assert expectation - should receive file-part message
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const partMessage = sentMessages[0] as FileMessage<ServerContext>;
    expect(partMessage.payload.type).toBe("file-part");
    expect((partMessage.payload as any).chunkIndex).toBe(0);
    expect((partMessage.payload as any).chunkData).toEqual(fileData);
    sentMessages.shift();
  });

  it("should handle download request for non-existent file", async () => {
    const fileStorage = new InMemoryFileStorage();
    const fileHandler = new FileHandler(fileStorage, emptyLogger);

    const sentMessages: Message<ServerContext>[] = [];
    const sendResponse = async (message: Message<ServerContext>) => {
      sentMessages.push(message);
    };

    // Client sends file-download request for non-existent file
    const downloadMessage = new FileMessage<ServerContext>("test-doc", {
      type: "file-download",
      fileId: "non-existent-file-id",
    });

    // let it be processed async
    await fileHandler.handle(downloadMessage, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should receive file-auth-message with denied permission
    expect(sentMessages.length).toBe(1);
    const authMessage = sentMessages[0] as FileMessage<ServerContext>;
    expect(authMessage.payload.type).toBe("file-auth-message");
    expect((authMessage.payload as any).permission).toBe("denied");
    expect((authMessage.payload as any).reason).toBe("File not found");
    expect((authMessage.payload as any).statusCode).toBe(404);
    sentMessages.shift();
  });

  it("should reject file upload that exceeds maximum size", async () => {
    const fileStorage = new InMemoryFileStorage();
    const fileHandler = new FileHandler(fileStorage, emptyLogger);

    const sentMessages: Message<ServerContext>[] = [];
    const sendResponse = async (message: Message<ServerContext>) => {
      sentMessages.push(message);
    };

    // Client sends file-upload message with size exceeding 1GB
    const uploadMessage = new FileMessage<ServerContext>("test-doc", {
      type: "file-upload",
      fileId: "large-upload-id",
      filename: "huge.txt",
      size: 2 * 1024 * 1024 * 1024, // 2GB
      mimeType: "text/plain",
      lastModified: Date.now(),
      encrypted: false,
    });

    // let it be processed async
    await fileHandler.handle(uploadMessage, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should receive file-auth-message with denied permission
    expect(sentMessages.length).toBe(1);
    const authMessage = sentMessages[0] as FileMessage<ServerContext>;
    expect(authMessage.payload.type).toBe("file-auth-message");
    expect((authMessage.payload as any).permission).toBe("denied");
    expect((authMessage.payload as any).statusCode).toBe(403);
    sentMessages.shift();
  });
});
