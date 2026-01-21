import { describe, expect, it } from "bun:test";
import { fromBase64, toBase64 } from "lib0/buffer";
import {
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
} from "teleportal/merkle-tree";
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
    const merkleTree = buildMerkleTree([fileData]);
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
});

describe("FileTransferProtocol.Server - file-part only", () => {
  it("should handle file-part RPC stream message and send ack", async () => {
    const sentMessages: Message[] = [];

    class TestServer extends FileTransferProtocol.Server<TestContext> {
      protected async checkUploadPermission(
        metadata: any,
        context: TestContext,
      ): Promise<{ allowed: boolean; reason?: string }> {
        return { allowed: true };
      }

      protected async onUploadStart(
        metadata: any,
        context: TestContext,
        document: string,
        encrypted: boolean,
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
        payload: any,
        context: TestContext,
        document: string,
        encrypted: boolean,
        sendMessage: (message: Message<TestContext>) => Promise<void>,
        originalMessage: any,
      ): Promise<void> {}
    }

    const server = new TestServer();
    const sendResponse = async (message: Message<TestContext>) => {
      sentMessages.push(message);
    };

    const fileData = new Uint8Array([1, 2, 3, 4, 5]);
    const merkleTree = buildMerkleTree([fileData]);
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
