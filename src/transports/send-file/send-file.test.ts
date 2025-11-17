import { beforeEach, describe, expect, it } from "bun:test";
import type { ClientContext, Message, Transport } from "teleportal";
import { FileMessage } from "teleportal/protocol";
import type {
  DecodedFileProgress,
  DecodedFileRequest,
} from "../../lib/protocol/types";
import { getFileTransport } from "./send-file";
import {
  buildMerkleTree,
  CHUNK_SIZE,
  generateMerkleProof,
} from "../../lib/merkle-tree/merkle-tree";

/**
 * Mock bidirectional transport for testing FileDownloader
 */
class MockBidirectionalTransport<Context extends Record<string, unknown>>
  implements Transport<Context>
{
  public readable: ReadableStream<Message<Context>>;
  public writable: WritableStream<Message<Context>>;
  [key: string]: unknown;
  private clientReadableController: ReadableStreamDefaultController<
    Message<Context>
  > | null = null;
  private clientWritable: WritableStream<Message<Context>>;
  private clientReadable: ReadableStream<Message<Context>>;
  private sentMessages: Message<Context>[] = [];

  constructor() {
    // Client readable: receives messages from server
    this.clientReadable = new ReadableStream<Message<Context>>({
      start: (controller) => {
        this.clientReadableController = controller;
      },
    });

    // Client writable: messages written here can be read by test
    this.clientWritable = new WritableStream<Message<Context>>({
      write: async (message) => {
        // Store message for test inspection
        this.sentMessages.push(message);
      },
    });

    // Default readable/writable for the transport interface
    this.readable = this.clientReadable;
    this.writable = this.clientWritable;
  }

  // Helper to send messages to client (simulating server responses)
  sendToClient(message: Message<Context>) {
    if (this.clientReadableController) {
      this.clientReadableController.enqueue(message);
    }
  }

  // Helper to close the readable stream
  close() {
    this.clientReadableController?.close();
  }

  // Helper to get client transport
  getClientTransport(): Transport<Context> {
    return {
      readable: this.clientReadable,
      writable: this.clientWritable,
    } as Transport<Context>;
  }

  // Helper to get sent messages
  getSentMessages(): Message<Context>[] {
    return this.sentMessages;
  }

  // Helper to clear sent messages
  clearSentMessages() {
    this.sentMessages = [];
  }
}

describe("FileDownloader", () => {
  let mockTransport: MockBidirectionalTransport<ClientContext>;
  let fileTransport: ReturnType<typeof getFileTransport>;
  const context: ClientContext = { clientId: "client-1" };

  beforeEach(() => {
    mockTransport = new MockBidirectionalTransport<ClientContext>();
    fileTransport = getFileTransport({
      transport: mockTransport.getClientTransport(),
      context,
    });
  });

  it("should download a single-chunk file successfully", async () => {
    const fileId = "test-file-id";
    const fileContent = new Uint8Array([1, 2, 3, 4, 5]);
    const filename = "test.txt";
    const mimeType = "text/plain";

    // Build merkle tree for the file
    const chunks = [fileContent];
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Start download in background
    const downloadPromise = fileTransport.download(contentId, fileId, false);

    // Simulate server sending metadata
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId,
          filename,
          size: fileContent.length,
          mimeType,
          contentId,
        },
        context,
        false,
      ),
    );

    // Simulate server sending chunk
    await new Promise((resolve) => setTimeout(resolve, 10));
    const proof = generateMerkleProof(merkleTree, 0);
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-progress",
          fileId,
          chunkIndex: 0,
          chunkData: fileContent,
          merkleProof: proof,
          totalChunks: 1,
          bytesUploaded: fileContent.length,
          encrypted: false,
        },
        context,
        false,
      ),
    );

    // Wait for download to complete
    const downloadedFile = await downloadPromise;

    // Verify file
    expect(downloadedFile).toBeInstanceOf(File);
    expect(downloadedFile.name).toBe(filename);
    expect(downloadedFile.type).toContain(mimeType); // File constructor may add charset
    expect(downloadedFile.size).toBe(fileContent.length);

    // Verify content
    const downloadedContent = new Uint8Array(
      await downloadedFile.arrayBuffer(),
    );
    expect(downloadedContent).toEqual(fileContent);
  });

  it("should download a multi-chunk file successfully", async () => {
    const fileId = "test-file-id";
    // Create a file larger than CHUNK_SIZE to ensure multiple chunks
    const fileSize = CHUNK_SIZE + 1000;
    const fileContent = new Uint8Array(fileSize);
    fileContent.fill(42); // Fill with test value
    const filename = "large-test.txt";
    const mimeType = "text/plain";

    // Split into chunks
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < fileContent.length; i += CHUNK_SIZE) {
      chunks.push(fileContent.slice(i, i + CHUNK_SIZE));
    }

    // Build merkle tree
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Start download in background
    const downloadPromise = fileTransport.download(contentId, fileId, false);

    // Simulate server sending metadata
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId,
          filename,
          size: fileContent.length,
          mimeType,
          contentId,
        },
        context,
        false,
      ),
    );

    // Simulate server sending chunks
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (let i = 0; i < chunks.length; i++) {
      const proof = generateMerkleProof(merkleTree, i);
      mockTransport.sendToClient(
        new FileMessage<ClientContext>(
          {
            type: "file-progress",
            fileId,
            chunkIndex: i,
            chunkData: chunks[i],
            merkleProof: proof,
            totalChunks: chunks.length,
            bytesUploaded: (i + 1) * CHUNK_SIZE,
            encrypted: false,
          },
          context,
          false,
        ),
      );
      // Small delay between chunks
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Wait for download to complete
    const downloadedFile = await downloadPromise;

    // Verify file
    expect(downloadedFile).toBeInstanceOf(File);
    expect(downloadedFile.name).toBe(filename);
    expect(downloadedFile.type).toContain(mimeType); // File constructor may add charset
    expect(downloadedFile.size).toBe(fileContent.length);

    // Verify content
    const downloadedContent = new Uint8Array(
      await downloadedFile.arrayBuffer(),
    );
    expect(downloadedContent).toEqual(fileContent);
  });

  it("should handle out-of-order chunks", async () => {
    const fileId = "test-file-id";
    const fileSize = CHUNK_SIZE * 3;
    const fileContent = new Uint8Array(fileSize);
    fileContent.fill(99);
    const filename = "out-of-order-test.txt";
    const mimeType = "text/plain";

    // Split into chunks
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < fileContent.length; i += CHUNK_SIZE) {
      chunks.push(fileContent.slice(i, i + CHUNK_SIZE));
    }

    // Build merkle tree
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Start download in background
    const downloadPromise = fileTransport.download(contentId, fileId, false);

    // Simulate server sending metadata
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId,
          filename,
          size: fileContent.length,
          mimeType,
          contentId,
        },
        context,
        false,
      ),
    );

    // Send chunks out of order: 2, 0, 1
    await new Promise((resolve) => setTimeout(resolve, 10));
    const order = [2, 0, 1];
    for (const i of order) {
      const proof = generateMerkleProof(merkleTree, i);
      mockTransport.sendToClient(
        new FileMessage<ClientContext>(
          {
            type: "file-progress",
            fileId,
            chunkIndex: i,
            chunkData: chunks[i],
            merkleProof: proof,
            totalChunks: chunks.length,
            bytesUploaded: (i + 1) * CHUNK_SIZE,
            encrypted: false,
          },
          context,
          false,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Wait for download to complete
    const downloadedFile = await downloadPromise;

    // Verify file content is correct despite out-of-order delivery
    const downloadedContent = new Uint8Array(
      await downloadedFile.arrayBuffer(),
    );
    expect(downloadedContent).toEqual(fileContent);
  });

  it("should handle empty file", async () => {
    const fileId = "test-file-id";
    const fileContent = new Uint8Array(0);
    const filename = "empty.txt";
    const mimeType = "text/plain";

    // Build merkle tree for empty file
    const chunks = [fileContent];
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Start download in background
    const downloadPromise = fileTransport.download(contentId, fileId, false);

    // Simulate server sending metadata
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId,
          filename,
          size: 0,
          mimeType,
          contentId,
        },
        context,
        false,
      ),
    );

    // Wait for download to complete (empty file should complete immediately after metadata)
    const downloadedFile = await downloadPromise;

    // Verify file
    expect(downloadedFile).toBeInstanceOf(File);
    expect(downloadedFile.name).toBe(filename);
    expect(downloadedFile.size).toBe(0);
  });

  it("should reject download with invalid merkle proof", async () => {
    const fileId = "test-file-id";
    const fileContent = new Uint8Array([1, 2, 3, 4, 5]);
    const filename = "test.txt";
    const mimeType = "text/plain";

    // Build merkle tree for the file
    const chunks = [fileContent];
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Start download in background
    const downloadPromise = fileTransport.download(contentId, fileId, false);

    // Simulate server sending metadata
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId,
          filename,
          size: fileContent.length,
          mimeType,
          contentId,
        },
        context,
        false,
      ),
    );

    // Simulate server sending chunk with invalid proof (wrong proof)
    await new Promise((resolve) => setTimeout(resolve, 10));
    const wrongProof = [new Uint8Array(32).fill(255)]; // Invalid proof
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-progress",
          fileId,
          chunkIndex: 0,
          chunkData: fileContent,
          merkleProof: wrongProof,
          totalChunks: 1,
          bytesUploaded: fileContent.length,
          encrypted: false,
        },
        context,
        false,
      ),
    );

    // Wait for download to fail
    await expect(downloadPromise).rejects.toThrow(
      "Chunk 0 failed merkle proof verification",
    );
  });

  it("should reject download with modified chunk data", async () => {
    const fileId = "test-file-id";
    const fileContent = new Uint8Array([1, 2, 3, 4, 5]);
    const modifiedContent = new Uint8Array([9, 9, 9, 9, 9]); // Modified
    const filename = "test.txt";
    const mimeType = "text/plain";

    // Build merkle tree for the original file
    const chunks = [fileContent];
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Start download in background
    const downloadPromise = fileTransport.download(contentId, fileId, false);

    // Simulate server sending metadata
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId,
          filename,
          size: fileContent.length,
          mimeType,
          contentId,
        },
        context,
        false,
      ),
    );

    // Simulate server sending modified chunk (with correct proof for original)
    await new Promise((resolve) => setTimeout(resolve, 10));
    const proof = generateMerkleProof(merkleTree, 0);
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-progress",
          fileId,
          chunkIndex: 0,
          chunkData: modifiedContent, // Modified data
          merkleProof: proof, // Proof for original data
          totalChunks: 1,
          bytesUploaded: fileContent.length,
          encrypted: false,
        },
        context,
        false,
      ),
    );

    // Wait for download to fail
    await expect(downloadPromise).rejects.toThrow(
      "Chunk 0 failed merkle proof verification",
    );
  });

  it("should reject download with missing chunks", async () => {
    const fileId = "test-file-id";
    const fileSize = CHUNK_SIZE * 3;
    const fileContent = new Uint8Array(fileSize);
    fileContent.fill(42);
    const filename = "test.txt";
    const mimeType = "text/plain";

    // Split into chunks
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < fileContent.length; i += CHUNK_SIZE) {
      chunks.push(fileContent.slice(i, i + CHUNK_SIZE));
    }

    // Build merkle tree
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Start download in background
    const downloadPromise = fileTransport.download(contentId, fileId, false);

    // Simulate server sending metadata
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId,
          filename,
          size: fileContent.length,
          mimeType,
          contentId,
        },
        context,
        false,
      ),
    );

    // Simulate server sending only first 2 chunks (missing the third)
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (let i = 0; i < chunks.length - 1; i++) {
      const proof = generateMerkleProof(merkleTree, i);
      mockTransport.sendToClient(
        new FileMessage<ClientContext>(
          {
            type: "file-progress",
            fileId,
            chunkIndex: i,
            chunkData: chunks[i],
            merkleProof: proof,
            totalChunks: chunks.length,
            bytesUploaded: (i + 1) * CHUNK_SIZE,
            encrypted: false,
          },
          context,
          false,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Close transport to trigger timeout/error
    await new Promise((resolve) => setTimeout(resolve, 100));
    mockTransport.close();

    // Wait for download to fail
    await expect(downloadPromise).rejects.toThrow();
  });

  it("should handle timeout", async () => {
    const fileId = "test-file-id";
    const contentId = new Uint8Array(32).fill(1);

    // Start download with short timeout
    const downloadPromise = fileTransport.download(
      contentId,
      fileId,
      false,
      100, // 100ms timeout
    );

    // Don't send any messages - should timeout
    await expect(downloadPromise).rejects.toThrow(
      "Download timeout after 100ms",
    );
  });

  it("should handle transport closure", async () => {
    const fileId = "test-file-id";
    const contentId = new Uint8Array(32).fill(1);

    // Start download with short timeout
    const downloadPromise = fileTransport.download(
      contentId,
      fileId,
      false,
      100, // 100ms timeout
    );

    // Close transport immediately
    mockTransport.close();

    // Should reject with timeout error (since stream closes and no messages arrive)
    await expect(downloadPromise).rejects.toThrow(
      "Download timeout after 100ms",
    );
  });

  it("should ignore messages for different fileId", async () => {
    const fileId = "test-file-id";
    const otherFileId = "other-file-id";
    const fileContent = new Uint8Array([1, 2, 3, 4, 5]);
    const filename = "test.txt";
    const mimeType = "text/plain";

    // Build merkle tree
    const chunks = [fileContent];
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Start download in background
    const downloadPromise = fileTransport.download(contentId, fileId, false);

    // Simulate server sending metadata for correct fileId
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId,
          filename,
          size: fileContent.length,
          mimeType,
          contentId,
        },
        context,
        false,
      ),
    );

    // Send chunk for wrong fileId (should be ignored)
    await new Promise((resolve) => setTimeout(resolve, 10));
    const proof = generateMerkleProof(merkleTree, 0);
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-progress",
          fileId: otherFileId, // Wrong fileId
          chunkIndex: 0,
          chunkData: fileContent,
          merkleProof: proof,
          totalChunks: 1,
          bytesUploaded: fileContent.length,
          encrypted: false,
        },
        context,
        false,
      ),
    );

    // Send correct chunk
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-progress",
          fileId, // Correct fileId
          chunkIndex: 0,
          chunkData: fileContent,
          merkleProof: proof,
          totalChunks: 1,
          bytesUploaded: fileContent.length,
          encrypted: false,
        },
        context,
        false,
      ),
    );

    // Download should complete successfully
    const downloadedFile = await downloadPromise;
    expect(downloadedFile).toBeInstanceOf(File);
    expect(downloadedFile.name).toBe(filename);
  });

  it("should handle chunks arriving before metadata", async () => {
    const fileId = "test-file-id";
    const fileContent = new Uint8Array([1, 2, 3, 4, 5]);
    const filename = "test.txt";
    const mimeType = "text/plain";

    // Build merkle tree
    const chunks = [fileContent];
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Start download in background
    const downloadPromise = fileTransport.download(contentId, fileId, false);

    // Send chunk BEFORE metadata
    await new Promise((resolve) => setTimeout(resolve, 10));
    const proof = generateMerkleProof(merkleTree, 0);
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-progress",
          fileId,
          chunkIndex: 0,
          chunkData: fileContent,
          merkleProof: proof,
          totalChunks: 1,
          bytesUploaded: fileContent.length,
          encrypted: false,
        },
        context,
        false,
      ),
    );

    // Then send metadata (this should trigger completion check)
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId,
          filename,
          size: fileContent.length,
          mimeType,
          contentId,
        },
        context,
        false,
      ),
    );

    // Download should complete successfully
    // Note: The current implementation requires metadata before completion,
    // so chunks arriving first will be stored but won't complete until metadata arrives
    const downloadedFile = await downloadPromise;
    expect(downloadedFile).toBeInstanceOf(File);
    expect(downloadedFile.name).toBe(filename);
  });
});

describe("FileUploader", () => {
  let mockTransport: MockBidirectionalTransport<ClientContext>;
  let fileTransport: ReturnType<typeof getFileTransport>;
  const context: ClientContext = { clientId: "client-1" };

  beforeEach(() => {
    mockTransport = new MockBidirectionalTransport<ClientContext>();
    fileTransport = getFileTransport({
      transport: mockTransport.getClientTransport(),
      context,
    });
    mockTransport.clearSentMessages();
  });

  it("should upload a single-chunk file successfully", async () => {
    const fileId = "test-file-id";
    const fileContent = new Uint8Array([1, 2, 3, 4, 5]);
    const filename = "test.txt";
    const mimeType = "text/plain";
    const file = new File([fileContent], filename, { type: mimeType });

    // Upload the file
    const contentId = await fileTransport.upload(file, fileId, false);

    // Wait for messages to be sent
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify contentId is correct
    const chunks = [fileContent];
    const merkleTree = buildMerkleTree(chunks);
    const expectedContentId =
      merkleTree.nodes[merkleTree.nodes.length - 1].hash;
    expect(contentId).toEqual(expectedContentId);

    // Verify messages were sent
    const sentMessages = mockTransport.getSentMessages();
    expect(sentMessages.length).toBeGreaterThan(0);

    // First message should be file-request
    const requestMessage = sentMessages[0] as FileMessage<ClientContext>;
    expect(requestMessage.type).toBe("file");
    expect(requestMessage.payload.type).toBe("file-request");
    const requestPayload = requestMessage.payload as DecodedFileRequest;
    expect(requestPayload.direction).toBe("upload");
    expect(requestPayload.fileId).toBe(fileId);
    expect(requestPayload.filename).toBe(filename);
    expect(requestPayload.size).toBe(fileContent.length);
    expect(requestPayload.mimeType).toContain(mimeType); // File constructor may add charset

    // Second message should be file-progress (chunk)
    const progressMessage = sentMessages[1] as FileMessage<ClientContext>;
    expect(progressMessage.type).toBe("file");
    expect(progressMessage.payload.type).toBe("file-progress");
    const progressPayload = progressMessage.payload as DecodedFileProgress;
    expect(progressPayload.fileId).toBe(fileId);
    expect(progressPayload.chunkIndex).toBe(0);
    expect(progressPayload.chunkData).toEqual(fileContent);
    expect(progressPayload.totalChunks).toBe(1);
  });

  it("should upload a multi-chunk file successfully", async () => {
    const fileId = "test-file-id";
    // Create a file larger than CHUNK_SIZE to ensure multiple chunks
    const fileSize = CHUNK_SIZE + 1000;
    const fileContent = new Uint8Array(fileSize);
    fileContent.fill(42); // Fill with test value
    const filename = "large-test.txt";
    const mimeType = "text/plain";
    const file = new File([fileContent], filename, { type: mimeType });

    // Upload the file
    const contentId = await fileTransport.upload(file, fileId, false);

    // Wait for messages to be sent
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify contentId is correct
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < fileContent.length; i += CHUNK_SIZE) {
      chunks.push(fileContent.slice(i, i + CHUNK_SIZE));
    }
    const merkleTree = buildMerkleTree(chunks);
    const expectedContentId =
      merkleTree.nodes[merkleTree.nodes.length - 1].hash;
    expect(contentId).toEqual(expectedContentId);

    // Verify messages were sent
    const sentMessages = mockTransport.getSentMessages();
    expect(sentMessages.length).toBe(chunks.length + 1); // 1 request + N chunks

    // First message should be file-request
    const requestMessage = sentMessages[0] as FileMessage<ClientContext>;
    expect(requestMessage.payload.type).toBe("file-request");
    const requestPayload = requestMessage.payload as DecodedFileRequest;
    expect(requestPayload.direction).toBe("upload");
    expect(requestPayload.fileId).toBe(fileId);
    expect(requestPayload.size).toBe(fileContent.length);

    // Verify all chunks were sent
    for (let i = 0; i < chunks.length; i++) {
      const progressMessage = sentMessages[i + 1] as FileMessage<ClientContext>;
      expect(progressMessage.payload.type).toBe("file-progress");
      const progressPayload = progressMessage.payload as DecodedFileProgress;
      expect(progressPayload.fileId).toBe(fileId);
      expect(progressPayload.chunkIndex).toBe(i);
      expect(progressPayload.chunkData).toEqual(chunks[i]);
      expect(progressPayload.totalChunks).toBe(chunks.length);
    }
  });

  it("should upload an empty file successfully", async () => {
    const fileId = "test-file-id";
    const fileContent = new Uint8Array(0);
    const filename = "empty.txt";
    const mimeType = "text/plain";
    const file = new File([fileContent], filename, { type: mimeType });

    // Upload the file
    const contentId = await fileTransport.upload(file, fileId, false);

    // Wait for messages to be sent
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify contentId is correct (empty file should have a specific merkle root)
    const chunks = [new Uint8Array(0)];
    const merkleTree = buildMerkleTree(chunks);
    const expectedContentId =
      merkleTree.nodes[merkleTree.nodes.length - 1].hash;
    expect(contentId).toEqual(expectedContentId);

    // Verify messages were sent
    const sentMessages = mockTransport.getSentMessages();
    expect(sentMessages.length).toBeGreaterThan(0);

    // First message should be file-request
    const requestMessage = sentMessages[0] as FileMessage<ClientContext>;
    expect(requestMessage.payload.type).toBe("file-request");
    const requestPayload = requestMessage.payload as DecodedFileRequest;
    expect(requestPayload.direction).toBe("upload");
    expect(requestPayload.size).toBe(0);
  });

  it("should include merkle proofs in chunk messages", async () => {
    const fileId = "test-file-id";
    // Use a multi-chunk file to ensure merkle proofs are non-empty
    const fileSize = CHUNK_SIZE + 1000;
    const fileContent = new Uint8Array(fileSize);
    fileContent.fill(42);
    const filename = "test.txt";
    const mimeType = "text/plain";
    const file = new File([fileContent], filename, { type: mimeType });

    // Upload the file
    await fileTransport.upload(file, fileId, false);

    // Wait for messages to be sent
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify merkle proof is included (for multi-chunk files, proofs should exist)
    const sentMessages = mockTransport.getSentMessages();
    const progressMessage = sentMessages[1] as FileMessage<ClientContext>;
    expect(progressMessage.payload.type).toBe("file-progress");
    const progressPayload = progressMessage.payload as DecodedFileProgress;
    expect(progressPayload.merkleProof).toBeDefined();
    expect(Array.isArray(progressPayload.merkleProof)).toBe(true);
    // For multi-chunk files, merkle proofs should be non-empty
    expect(progressPayload.merkleProof.length).toBeGreaterThan(0);
  });
});

describe("FileUploader and FileDownloader integration", () => {
  let mockTransport: MockBidirectionalTransport<ClientContext>;
  let fileTransport: ReturnType<typeof getFileTransport>;
  const context: ClientContext = { clientId: "client-1" };

  beforeEach(() => {
    mockTransport = new MockBidirectionalTransport<ClientContext>();
    fileTransport = getFileTransport({
      transport: mockTransport.getClientTransport(),
      context,
    });
    mockTransport.clearSentMessages();
  });

  it("should upload and then download the same file", async () => {
    const uploadFileId = "upload-file-id";
    const downloadFileId = "download-file-id";
    const fileContent = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const filename = "test.txt";
    const mimeType = "text/plain";
    const file = new File([fileContent], filename, { type: mimeType });

    // Upload the file
    const contentId = await fileTransport.upload(file, uploadFileId, false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Simulate server storing the file and responding to download request
    // First, capture the upload messages to simulate server behavior
    const sentMessages = mockTransport.getSentMessages();
    const uploadRequest = sentMessages[0] as FileMessage<ClientContext>;
    const uploadRequestPayload = uploadRequest.payload as DecodedFileRequest;
    const uploadChunks = sentMessages.slice(1) as FileMessage<ClientContext>[];

    // Start download
    const downloadPromise = fileTransport.download(
      contentId,
      downloadFileId,
      false,
    );

    // Simulate server sending metadata for download
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId: downloadFileId,
          filename: uploadRequestPayload.filename,
          size: uploadRequestPayload.size,
          mimeType: uploadRequestPayload.mimeType,
          contentId,
        },
        context,
        false,
      ),
    );

    // Simulate server sending chunks (reusing the chunks from upload)
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const chunkMessage of uploadChunks) {
      const chunkPayload = chunkMessage.payload as DecodedFileProgress;
      mockTransport.sendToClient(
        new FileMessage<ClientContext>(
          {
            type: "file-progress",
            fileId: downloadFileId,
            chunkIndex: chunkPayload.chunkIndex,
            chunkData: chunkPayload.chunkData,
            merkleProof: chunkPayload.merkleProof,
            totalChunks: chunkPayload.totalChunks,
            bytesUploaded: chunkPayload.bytesUploaded,
            encrypted: false,
          },
          context,
          false,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Wait for download to complete
    const downloadedFile = await downloadPromise;

    // Verify downloaded file matches uploaded file
    expect(downloadedFile).toBeInstanceOf(File);
    expect(downloadedFile.name).toBe(filename);
    expect(downloadedFile.size).toBe(fileContent.length);

    const downloadedContent = new Uint8Array(
      await downloadedFile.arrayBuffer(),
    );
    expect(downloadedContent).toEqual(fileContent);
  });

  it("should upload a large file and then download it", async () => {
    const uploadFileId = "upload-file-id";
    const downloadFileId = "download-file-id";
    const fileSize = CHUNK_SIZE * 3;
    const fileContent = new Uint8Array(fileSize);
    fileContent.fill(99);
    const filename = "large-test.txt";
    const mimeType = "text/plain";
    const file = new File([fileContent], filename, { type: mimeType });

    // Upload the file
    const contentId = await fileTransport.upload(file, uploadFileId, false);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Capture upload messages
    const sentMessages = mockTransport.getSentMessages();
    const uploadRequest = sentMessages[0] as FileMessage<ClientContext>;
    const uploadRequestPayload = uploadRequest.payload as DecodedFileRequest;
    const uploadChunks = sentMessages.slice(1) as FileMessage<ClientContext>[];

    // Start download
    const downloadPromise = fileTransport.download(
      contentId,
      downloadFileId,
      false,
    );

    // Simulate server sending metadata
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId: downloadFileId,
          filename: uploadRequestPayload.filename,
          size: uploadRequestPayload.size,
          mimeType: uploadRequestPayload.mimeType,
          contentId,
        },
        context,
        false,
      ),
    );

    // Simulate server sending chunks
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const chunkMessage of uploadChunks) {
      const chunkPayload = chunkMessage.payload as DecodedFileProgress;
      mockTransport.sendToClient(
        new FileMessage<ClientContext>(
          {
            type: "file-progress",
            fileId: downloadFileId,
            chunkIndex: chunkPayload.chunkIndex,
            chunkData: chunkPayload.chunkData,
            merkleProof: chunkPayload.merkleProof,
            totalChunks: chunkPayload.totalChunks,
            bytesUploaded: chunkPayload.bytesUploaded,
            encrypted: false,
          },
          context,
          false,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Wait for download to complete
    const downloadedFile = await downloadPromise;

    // Verify downloaded file matches uploaded file
    expect(downloadedFile).toBeInstanceOf(File);
    expect(downloadedFile.name).toBe(filename);
    expect(downloadedFile.size).toBe(fileContent.length);

    const downloadedContent = new Uint8Array(
      await downloadedFile.arrayBuffer(),
    );
    expect(downloadedContent).toEqual(fileContent);
  });

  it("should handle multiple uploads and downloads", async () => {
    const file1Content = new Uint8Array([1, 2, 3]);
    const file1 = new File([file1Content], "file1.txt", {
      type: "text/plain",
    });
    const file2Content = new Uint8Array([4, 5, 6]);
    const file2 = new File([file2Content], "file2.txt", {
      type: "text/plain",
    });

    // Upload both files
    const contentId1 = await fileTransport.upload(file1, "upload-1", false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.clearSentMessages();

    const contentId2 = await fileTransport.upload(file2, "upload-2", false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify contentIds are different
    expect(contentId1).not.toEqual(contentId2);

    // Download first file
    const downloadPromise1 = fileTransport.download(
      contentId1,
      "download-1",
      false,
    );

    // Simulate server response for first file
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId: "download-1",
          filename: "file1.txt",
          size: file1Content.length,
          mimeType: "text/plain",
          contentId: contentId1,
        },
        context,
        false,
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    const chunks1 = [file1Content];
    const merkleTree1 = buildMerkleTree(chunks1);
    const proof1 = generateMerkleProof(merkleTree1, 0);
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-progress",
          fileId: "download-1",
          chunkIndex: 0,
          chunkData: file1Content,
          merkleProof: proof1,
          totalChunks: 1,
          bytesUploaded: file1Content.length,
          encrypted: false,
        },
        context,
        false,
      ),
    );

    const downloadedFile1 = await downloadPromise1;
    expect(downloadedFile1.name).toBe("file1.txt");
    const downloadedContent1 = new Uint8Array(
      await downloadedFile1.arrayBuffer(),
    );
    expect(downloadedContent1).toEqual(file1Content);

    // Download second file
    const downloadPromise2 = fileTransport.download(
      contentId2,
      "download-2",
      false,
    );

    // Simulate server response for second file
    await new Promise((resolve) => setTimeout(resolve, 10));
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-request",
          direction: "download",
          fileId: "download-2",
          filename: "file2.txt",
          size: file2Content.length,
          mimeType: "text/plain",
          contentId: contentId2,
        },
        context,
        false,
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    const chunks2 = [file2Content];
    const merkleTree2 = buildMerkleTree(chunks2);
    const proof2 = generateMerkleProof(merkleTree2, 0);
    mockTransport.sendToClient(
      new FileMessage<ClientContext>(
        {
          type: "file-progress",
          fileId: "download-2",
          chunkIndex: 0,
          chunkData: file2Content,
          merkleProof: proof2,
          totalChunks: 1,
          bytesUploaded: file2Content.length,
          encrypted: false,
        },
        context,
        false,
      ),
    );

    const downloadedFile2 = await downloadPromise2;
    expect(downloadedFile2.name).toBe("file2.txt");
    const downloadedContent2 = new Uint8Array(
      await downloadedFile2.arrayBuffer(),
    );
    expect(downloadedContent2).toEqual(file2Content);
  });
});
