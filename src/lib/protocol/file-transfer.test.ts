import { describe, expect, it } from "bun:test";
import { fromBase64, toBase64 } from "lib0/buffer";
import { AckMessage, FileMessage, type Message } from "./message-types";

type TestContext = Record<string, unknown>;
import {
  buildMerkleTree,
  CHUNK_SIZE,
  generateMerkleProof,
  verifyMerkleProof,
} from "../merkle-tree/merkle-tree";
import { FileTransferProtocol } from "./file-transfer";
import type { DecodedFilePart, DecodedFileUpload } from "./types";

describe("FileTransferProtocol.Client", () => {
  it("should handle file upload request and send file-upload message", async () => {
    const sentMessages: Message[] = [];
    const receivedFiles: File[] = [];

    class TestClient extends FileTransferProtocol.Client {
      sendMessage(message: Message): void {
        sentMessages.push(message);
      }

      async onDownloadComplete(
        state: FileTransferProtocol.DownloadState,
        file: File,
      ): Promise<void> {
        receivedFiles.push(file);
      }

      protected verifyChunk(chunk: DecodedFilePart, fileId: string): boolean {
        return verifyMerkleProof(
          chunk.chunkData,
          chunk.merkleProof,
          fromBase64(fileId),
          chunk.chunkIndex,
        );
      }
    }

    const client = new TestClient();

    // Start upload
    const uploadPromise = client.requestUpload(
      new File([new Uint8Array([1, 2, 3, 4, 5])], "test.txt"),
      "test-doc",
      "test-upload-id",
      false,
    );
    // let it be processed async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should send file-upload message
    expect(sentMessages.length).toBe(1);
    const uploadMessage = sentMessages[0] as FileMessage<TestContext>;
    expect(uploadMessage.payload.type).toBe("file-upload");
    expect((uploadMessage.payload as any).fileId).toBe("test-upload-id");
    expect((uploadMessage.payload as any).filename).toBe("test.txt");
    expect((uploadMessage.payload as any).size).toBe(5);
    sentMessages.shift();

    // Act as server and send file-download (authorization)
    await client.handleMessage(
      new FileMessage<TestContext>("test-doc", {
        type: "file-download",
        fileId: "test-upload-id",
      }),
    );
    // let it be processed async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should send file-part message
    expect(sentMessages.length).toBe(1);
    const partMessage = sentMessages[0] as FileMessage<TestContext>;
    expect(partMessage.payload.type).toBe("file-part");
    expect((partMessage.payload as any).chunkIndex).toBe(0);
    sentMessages.shift();

    // Act as server and send ack
    await client.handleMessage(
      new AckMessage<TestContext>({
        type: "ack",
        messageId: partMessage.id,
      }),
    );
    // let it be processed async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Upload should be complete
    const uploadResult = await uploadPromise;
    expect(uploadResult).toBeDefined();
    expect(typeof uploadResult).toBe("string");
  });

  it("should handle multi-chunk upload", async () => {
    const sentMessages: Message[] = [];

    class TestClient extends FileTransferProtocol.Client {
      sendMessage(message: Message): void {
        sentMessages.push(message);
      }

      async onDownloadComplete(
        state: FileTransferProtocol.DownloadState,
        file: File,
      ): Promise<void> {}

      protected verifyChunk(chunk: DecodedFilePart, fileId: string): boolean {
        return verifyMerkleProof(
          chunk.chunkData,
          chunk.merkleProof,
          fromBase64(fileId),
          chunk.chunkIndex,
        );
      }
    }

    const client = new TestClient();

    // Create a file larger than one chunk
    const largeFileData = new Uint8Array(CHUNK_SIZE + 100);
    largeFileData.fill(42);

    // Start upload
    const uploadPromise = client.requestUpload(
      new File([largeFileData], "large.txt"),
      "test-doc",
      "large-upload-id",
      false,
    );
    // let it be processed async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should send file-upload message
    expect(sentMessages.length).toBe(1);
    const uploadMessage = sentMessages[0] as FileMessage<TestContext>;
    expect(uploadMessage.payload.type).toBe("file-upload");
    sentMessages.shift();

    // Act as server and send file-download (authorization)
    await client.handleMessage(
      new FileMessage<TestContext>("test-doc", {
        type: "file-download",
        fileId: "large-upload-id",
      }),
    );
    // let it be processed async - client sends all chunks immediately
    await new Promise((resolve) => setTimeout(resolve, 10));

    // assert expectation - should send both file-part messages
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const part1Message = sentMessages[0] as FileMessage<TestContext>;
    expect(part1Message.payload.type).toBe("file-part");
    expect((part1Message.payload as any).chunkIndex).toBe(0);
    sentMessages.shift();

    // ACK first chunk
    await client.handleMessage(
      new AckMessage<TestContext>({
        type: "ack",
        messageId: part1Message.id,
      }),
    );
    // let it be processed async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should have second file-part
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const part2Message = sentMessages[0] as FileMessage<TestContext>;
    expect(part2Message.payload.type).toBe("file-part");
    expect((part2Message.payload as any).chunkIndex).toBe(1);
    sentMessages.shift();

    // ACK second chunk
    await client.handleMessage(
      new AckMessage<TestContext>({
        type: "ack",
        messageId: part2Message.id,
      }),
    );
    // let it be processed async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Upload should be complete
    const uploadResult = await uploadPromise;
    expect(uploadResult).toBeDefined();
    expect(typeof uploadResult).toBe("string");
  });

  it("should handle file download request and receive file", async () => {
    const sentMessages: Message[] = [];
    const receivedFiles: File[] = [];

    class TestClient extends FileTransferProtocol.Client {
      sendMessage(message: Message): void {
        sentMessages.push(message);
      }

      async onDownloadComplete(
        state: FileTransferProtocol.DownloadState,
        file: File,
      ): Promise<void> {
        receivedFiles.push(file);
      }

      protected verifyChunk(chunk: DecodedFilePart, fileId: string): boolean {
        return verifyMerkleProof(
          chunk.chunkData,
          chunk.merkleProof,
          fromBase64(fileId),
          chunk.chunkIndex,
        );
      }
    }

    const client = new TestClient();

    // Prepare file data and calculate contentId
    const fileData = new Uint8Array([1, 2, 3, 4, 5]);
    const merkleTree = buildMerkleTree([fileData]);
    const contentId = toBase64(
      merkleTree.nodes[merkleTree.nodes.length - 1].hash,
    );

    // Start download
    const downloadPromise = client.requestDownload(
      contentId,
      "test-doc",
      false,
    );
    // let it be processed async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should send file-download request
    expect(sentMessages.length).toBe(1);
    const downloadRequest = sentMessages[0] as FileMessage<TestContext>;
    expect(downloadRequest.payload.type).toBe("file-download");
    expect((downloadRequest.payload as any).fileId).toBe(contentId);
    sentMessages.shift();

    // Act as server and send file-upload (metadata)
    await client.handleMessage(
      new FileMessage<TestContext>("test-doc", {
        type: "file-upload",
        fileId: contentId,
        filename: "downloaded.txt",
        size: 5,
        mimeType: "text/plain",
        lastModified: Date.now(),
        encrypted: false,
      }),
    );
    // let it be processed async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Act as server and send file-part
    const proof = generateMerkleProof(merkleTree, 0);
    await client.handleMessage(
      new FileMessage<TestContext>("test-doc", {
        type: "file-part",
        fileId: contentId,
        chunkIndex: 0,
        chunkData: fileData,
        merkleProof: proof,
        totalChunks: 1,
        bytesUploaded: 5,
        encrypted: false,
      } as any),
    );
    // let it be processed async
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Download should complete
    const downloadedFile = await downloadPromise;
    expect(downloadedFile).toBeInstanceOf(File);
    expect(downloadedFile.name).toBe("downloaded.txt");
    expect(downloadedFile.size).toBe(5);
    expect(receivedFiles.length).toBe(1);
  });
});

describe("FileTransferProtocol.Server", () => {
  it("should handle file-upload request and authorize it", async () => {
    const sentMessages: Message[] = [];
    let uploadStarted = false;

    class TestServer extends FileTransferProtocol.Server {
      protected async checkUploadPermission(
        metadata: DecodedFileUpload,
        context: any,
      ): Promise<{ allowed: boolean; reason?: string }> {
        return { allowed: true };
      }

      protected async onUploadStart(
        metadata: DecodedFileUpload,
        context: any,
        document: string,
        encrypted: boolean,
      ): Promise<void> {
        uploadStarted = true;
      }

      protected async onChunkReceived(
        payload: DecodedFilePart,
        messageId: string,
        context: any,
        document: string,
        sendMessage: (message: Message) => Promise<void>,
      ): Promise<void> {
        await sendMessage(
          new AckMessage({
            type: "ack",
            messageId,
          }),
        );
      }

      protected async onDownloadRequest(
        payload: any,
        context: any,
        document: string,
        encrypted: boolean,
        sendMessage: (message: Message) => Promise<void>,
      ): Promise<void> {
        // Not used in this test
      }
    }

    const server = new TestServer();
    const sendResponse = async (message: Message) => {
      sentMessages.push(message);
    };

    // Client sends file-upload message
    const uploadMessage = new FileMessage<TestContext>("test-doc", {
      type: "file-upload",
      fileId: "test-upload-id",
      filename: "test.txt",
      size: 5,
      mimeType: "text/plain",
      lastModified: Date.now(),
      encrypted: false,
    });

    // let it be processed async
    await server.handleMessage(uploadMessage, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should send file-download message (authorization)
    expect(sentMessages.length).toBe(1);
    const authMessage = sentMessages[0] as FileMessage<TestContext>;
    expect(authMessage.payload.type).toBe("file-download");
    expect((authMessage.payload as any).fileId).toBe("test-upload-id");
    sentMessages.shift();

    // Check that upload was started
    expect(uploadStarted).toBe(true);
  });

  it("should handle file-part message and send ack", async () => {
    const sentMessages: Message[] = [];

    class TestServer extends FileTransferProtocol.Server {
      protected async checkUploadPermission(
        metadata: DecodedFileUpload,
        context: any,
      ): Promise<{ allowed: boolean; reason?: string }> {
        return { allowed: true };
      }

      protected async onUploadStart(
        metadata: DecodedFileUpload,
        context: any,
        document: string,
        encrypted: boolean,
      ): Promise<void> {}

      protected async onChunkReceived(
        payload: DecodedFilePart,
        messageId: string,
        context: any,
        document: string,
        sendMessage: (message: Message) => Promise<void>,
      ): Promise<void> {
        await sendMessage(
          new AckMessage({
            type: "ack",
            messageId,
          }),
        );
      }

      protected async onDownloadRequest(
        payload: any,
        context: any,
        document: string,
        encrypted: boolean,
        sendMessage: (message: Message) => Promise<void>,
      ): Promise<void> {
        // Not used in this test
      }
    }

    const server = new TestServer();
    const sendResponse = async (message: Message) => {
      sentMessages.push(message);
    };

    // Client sends file-part message
    const fileData = new Uint8Array([1, 2, 3, 4, 5]);
    const merkleTree = buildMerkleTree([fileData]);
    const proof = generateMerkleProof(merkleTree, 0);

    const partMessage = new FileMessage<TestContext>("test-doc", {
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
    await server.handleMessage(partMessage, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should send ack message
    expect(sentMessages.length).toBe(1);
    const ackMessage = sentMessages[0] as AckMessage<TestContext>;
    expect(ackMessage.payload.type).toBe("ack");
    expect(ackMessage.payload.messageId).toBe(partMessage.id);
    sentMessages.shift();
  });

  it("should reject file-upload request if permission denied", async () => {
    const sentMessages: Message[] = [];

    class TestServer extends FileTransferProtocol.Server {
      protected async checkUploadPermission(
        metadata: DecodedFileUpload,
        context: any,
      ): Promise<{ allowed: boolean; reason?: string }> {
        return {
          allowed: false,
          reason: "Upload not allowed",
        };
      }

      protected async onUploadStart(
        metadata: DecodedFileUpload,
        context: any,
        document: string,
        encrypted: boolean,
      ): Promise<void> {
        // Should not be called
      }

      protected async onChunkReceived(
        payload: DecodedFilePart,
        messageId: string,
        context: any,
        document: string,
        sendMessage: (message: Message) => Promise<void>,
      ): Promise<void> {
        // Not used in this test
      }

      protected async onDownloadRequest(
        payload: any,
        context: any,
        document: string,
        encrypted: boolean,
        sendMessage: (message: Message) => Promise<void>,
      ): Promise<void> {
        // Not used in this test
      }
    }

    const server = new TestServer();
    const sendResponse = async (message: Message) => {
      sentMessages.push(message);
    };

    // Client sends file-upload message
    const uploadMessage = new FileMessage<TestContext>("test-doc", {
      type: "file-upload",
      fileId: "test-upload-id",
      filename: "test.txt",
      size: 5,
      mimeType: "text/plain",
      lastModified: Date.now(),
      encrypted: false,
    });

    // let it be processed async
    await server.handleMessage(uploadMessage, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should send file-auth-message with denied permission
    expect(sentMessages.length).toBe(1);
    const authMessage = sentMessages[0] as FileMessage<TestContext>;
    expect(authMessage.payload.type).toBe("file-auth-message");
    expect((authMessage.payload as any).permission).toBe("denied");
    expect((authMessage.payload as any).reason).toBe("Upload not allowed");
    expect((authMessage.payload as any).statusCode).toBe(403);
    sentMessages.shift();
  });

  it("should handle download request", async () => {
    const sentMessages: Message[] = [];
    let downloadRequested = false;

    class TestServer extends FileTransferProtocol.Server {
      protected async checkUploadPermission(
        metadata: DecodedFileUpload,
        context: any,
      ): Promise<{ allowed: boolean; reason?: string }> {
        return { allowed: true };
      }

      protected async onUploadStart(
        metadata: DecodedFileUpload,
        context: any,
        document: string,
        encrypted: boolean,
      ): Promise<void> {}

      protected async onChunkReceived(
        payload: DecodedFilePart,
        messageId: string,
        context: any,
        document: string,
        sendMessage: (message: Message) => Promise<void>,
      ): Promise<void> {
        // Not used in this test
      }

      protected async onDownloadRequest(
        payload: any,
        context: any,
        document: string,
        encrypted: boolean,
        sendMessage: (message: Message) => Promise<void>,
      ): Promise<void> {
        downloadRequested = true;
        // Send file metadata
        await sendMessage(
          new FileMessage<TestContext>("test-doc", {
            type: "file-upload",
            fileId: payload.fileId,
            filename: "downloaded.txt",
            size: 5,
            mimeType: "text/plain",
            lastModified: Date.now(),
            encrypted: false,
          }),
        );
      }
    }

    const server = new TestServer();
    const sendResponse = async (message: Message) => {
      sentMessages.push(message);
    };

    // Client sends file-download request
    const downloadMessage = new FileMessage<TestContext>("test-doc", {
      type: "file-download",
      fileId: "test-file-id",
    });

    // let it be processed async
    await server.handleMessage(downloadMessage, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    // assert expectation - should call onDownloadRequest
    expect(downloadRequested).toBe(true);
    expect(sentMessages.length).toBe(1);
    const metadataMessage = sentMessages[0] as FileMessage<TestContext>;
    expect(metadataMessage.payload.type).toBe("file-upload");
    expect((metadataMessage.payload as any).filename).toBe("downloaded.txt");
    sentMessages.shift();
  });
});
