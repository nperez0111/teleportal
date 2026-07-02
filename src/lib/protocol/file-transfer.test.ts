import { describe, expect, it } from "bun:test";
import { fromBase64, toBase64 } from "lib0/buffer";
import { buildMerkleTree, generateMerkleProof, verifyMerkleProof } from "teleportal/merkle-tree";
import { RpcMessage } from "teleportal/protocol";
import type { FilePartStream } from "../../protocols/file/methods";
import { FileTransferProtocol } from "./file-transfer";
import { AckMessage, type Message } from "./message-types";

type TestContext = Record<string, unknown>;

describe("FileTransferProtocol.Client - file-part only", () => {
  it("should handle file-part message", async () => {
    const sentMessages: Message[] = [];
    const receivedFiles: File[] = [];

    class TestClient extends FileTransferProtocol.Client<TestContext> {
      sendMessage(message: Message<TestContext>): void {
        sentMessages.push(message);
      }

      async onDownloadComplete(
        state: FileTransferProtocol.DownloadState,
        file: File,
      ): Promise<void> {
        receivedFiles.push(file);
      }

      protected verifyChunk(chunk: FilePartStream, fileId: string): boolean {
        return verifyMerkleProof(
          chunk.chunkData,
          chunk.merkleProof,
          fromBase64(fileId),
          chunk.chunkIndex,
        );
      }
    }

    const client = new TestClient();

    const fileData = new Uint8Array([1, 2, 3, 4, 5]);
    const merkleTree = await buildMerkleTree([fileData]);
    const root = merkleTree.nodes.at(-1);
    expect(root).toBeDefined();
    const contentId = toBase64(root!.hash!);

    const downloadPromise = client.requestDownload(contentId, "test-doc");
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(sentMessages.length).toBe(1);
    const downloadRequest = sentMessages[0] as any;
    expect(downloadRequest.type).toBe("rpc");
    sentMessages.shift();

    const proof = generateMerkleProof(merkleTree, 0);

    const mockRpcResponse = new RpcMessage<TestContext>(
      "test-doc",
      {
        type: "success",
        payload: {
          fileId: contentId,
          filename: "test.txt",
          size: 5,
          mimeType: "application/octet-stream",
        },
      },
      "fileDownload",
      "response",
      downloadRequest.id,
      {},
      false,
    );
    await client.handleMessage(mockRpcResponse);

    const filePart: FilePartStream = {
      fileId: contentId,
      chunkIndex: 0,
      chunkData: fileData,
      merkleProof: proof,
      totalChunks: 1,
      bytesUploaded: 5,
      encrypted: false,
    };

    await client.handleMessage(
      new RpcMessage<TestContext>(
        "test-doc",
        { type: "success", payload: filePart },
        "fileDownload",
        "stream",
        downloadRequest.id,
        {},
        false,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 1));

    const downloadedFile = await downloadPromise;
    expect(downloadedFile).toBeInstanceOf(File);
    expect(downloadedFile.size).toBe(5);
    expect(receivedFiles.length).toBe(1);
  });

  it("uses the stream's totalChunks (not size) to detect completion", async () => {
    const sentMessages: Message[] = [];

    class TestClient extends FileTransferProtocol.Client<TestContext> {
      sendMessage(message: Message<TestContext>): void {
        sentMessages.push(message);
      }
      async onDownloadComplete(): Promise<void> {}
      protected verifyChunk(chunk: FilePartStream, fileId: string): boolean {
        return verifyMerkleProof(
          chunk.chunkData,
          chunk.merkleProof,
          fromBase64(fileId),
          chunk.chunkIndex,
        );
      }
    }

    const client = new TestClient();

    // Two chunks whose combined size is far below CHUNK_SIZE, so deriving the
    // chunk count from `size / CHUNK_SIZE` would wrongly conclude a single
    // chunk and complete the download early with a truncated file.
    const chunk0 = new Uint8Array([1, 2, 3, 4, 5]);
    const chunk1 = new Uint8Array([6, 7, 8]);
    const merkleTree = await buildMerkleTree([chunk0, chunk1]);
    const contentId = toBase64(merkleTree.nodes.at(-1)!.hash!);

    const downloadPromise = client.requestDownload(contentId, "test-doc");
    await new Promise((resolve) => setTimeout(resolve, 1));
    const downloadRequest = sentMessages.shift() as any;

    await client.handleMessage(
      new RpcMessage<TestContext>(
        "test-doc",
        {
          type: "success",
          payload: {
            fileId: contentId,
            filename: "test.txt",
            size: chunk0.length + chunk1.length,
            mimeType: "application/octet-stream",
          },
        },
        "fileDownload",
        "response",
        downloadRequest.id,
        {},
        false,
      ),
    );

    const makePart = (index: number, data: Uint8Array): FilePartStream => ({
      fileId: contentId,
      chunkIndex: index,
      chunkData: data,
      merkleProof: generateMerkleProof(merkleTree, index),
      totalChunks: 2,
      bytesUploaded: data.length,
      encrypted: false,
    });

    await client.handleMessage(
      new RpcMessage<TestContext>(
        "test-doc",
        { type: "success", payload: makePart(0, chunk0) },
        "fileDownload",
        "stream",
        downloadRequest.id,
        {},
        false,
      ),
    );
    await client.handleMessage(
      new RpcMessage<TestContext>(
        "test-doc",
        { type: "success", payload: makePart(1, chunk1) },
        "fileDownload",
        "stream",
        downloadRequest.id,
        {},
        false,
      ),
    );

    const downloadedFile = await downloadPromise;
    expect(downloadedFile.size).toBe(chunk0.length + chunk1.length);
  });
});

describe("FileTransferProtocol.Server - file-part only", () => {
  it("should handle file-part RPC stream message and send ack", async () => {
    const sentMessages: Message[] = [];

    class TestServer extends FileTransferProtocol.Server<TestContext> {
      protected async checkUploadPermission(
        _metadata: any,
        _context: TestContext,
      ): Promise<{ allowed: boolean; reason?: string }> {
        return { allowed: true };
      }

      protected async onUploadStart(
        _metadata: any,
        _context: TestContext,
        _document: string,
        _encrypted: boolean,
      ): Promise<void> {}

      protected async onChunkReceived(
        payload: FilePartStream,
        messageId: string,
        document: string,
        context: TestContext,
        sendMessage: (message: Message<TestContext>) => Promise<void>,
      ): Promise<void> {
        await sendMessage(
          new AckMessage({
            type: "ack",
            messageId,
          }),
        );
      }

      protected async onDownloadRequest(
        _payload: any,
        _context: TestContext,
        _document: string,
        _encrypted: boolean,
        _sendMessage: (message: Message<TestContext>) => Promise<void>,
        _originalMessage: any,
      ): Promise<void> {}
    }

    const server = new TestServer();
    const sendResponse = async (message: Message<TestContext>) => {
      sentMessages.push(message);
    };

    const fileData = new Uint8Array([1, 2, 3, 4, 5]);
    const merkleTree = await buildMerkleTree([fileData]);
    const proof = generateMerkleProof(merkleTree, 0);

    const filePart: FilePartStream = {
      fileId: "test-upload-id",
      chunkIndex: 0,
      chunkData: fileData,
      merkleProof: proof,
      totalChunks: 1,
      bytesUploaded: 5,
      encrypted: false,
    };

    const partMessage = new RpcMessage<TestContext>(
      "test-doc",
      { type: "success", payload: filePart },
      "fileDownload",
      "stream",
      "original-request-id",
      {},
      false,
    );

    await server.handleMessage(partMessage, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(sentMessages.length).toBe(1);
    const ackMessage = sentMessages[0] as AckMessage<TestContext>;
    expect(ackMessage.payload.type).toBe("ack");
    expect(ackMessage.payload.messageId).toBe(partMessage.id);
    sentMessages.shift();
  });
});
