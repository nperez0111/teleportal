import { describe, expect, it } from "bun:test";
import type { ServerContext, Message } from "teleportal";
import { FileMessage } from "teleportal";
import { InMemoryFileStorage } from "teleportal/storage";
import {
  buildMerkleTree,
  generateMerkleProof,
  getMerkleRoot,
} from "teleportal/protocol";
import { FileTransferHandler } from "./file-handler";
import type { Logger } from "./logger";
import { logger as baseLogger } from "./logger";

const testContext: ServerContext = {
  userId: "user-1",
  room: "room-1",
  clientId: "client-1",
};

class TestClient<Context extends ServerContext> {
  id = "test-client";
  sent: Message<Context>[] = [];

  async send(message: Message<Context>): Promise<void> {
    this.sent.push(message);
  }
}

function createHandler(logger?: Logger) {
  const storage = new InMemoryFileStorage();
  return {
    storage,
    handler: new FileTransferHandler<ServerContext>({
      storage,
      logger: (logger ?? baseLogger).child(),
    }),
  };
}

function createUploadPayload(size = 4) {
  const chunk = new Uint8Array(size).fill(1);
  const tree = buildMerkleTree([chunk]);
  const proof = generateMerkleProof(tree, 0);
  const root = getMerkleRoot(tree);
  return { chunk, proof, root };
}

describe("FileTransferHandler uploads", () => {
  it("accepts upload requests and completes upload", async () => {
    const handler = createHandler();
    const { handler: fileHandler } = handler;
    const client = new TestClient<ServerContext>();
    const { chunk, proof, root } = createUploadPayload();

    const request = new FileMessage(
      {
        type: "file-request",
        direction: "upload",
        fileId: "file-1",
        filename: "test.bin",
        size: chunk.length,
        mimeType: "application/octet-stream",
        contentId: root,
        encrypted: false,
      },
      testContext,
    );

    await fileHandler.handle(request, client as unknown as any);
    expect(client.sent.length).toBe(1);
    const ack = client.sent[0] as FileMessage<ServerContext>;
    expect(ack.payload.status).toBe("accepted");

    const progress = new FileMessage(
      {
        type: "file-progress",
        fileId: "file-1",
        chunkIndex: 0,
        chunkData: chunk,
        merkleProof: proof,
        totalChunks: 1,
        bytesUploaded: chunk.length,
        encrypted: false,
      },
      testContext,
    );

    await fileHandler.handle(progress, client as unknown as any);
    expect(client.sent.length).toBe(2);
    const completion = client.sent[1] as FileMessage<ServerContext>;
    expect(completion.payload.resumeFromChunk).toBe(1);
  });

  it("supports resumable uploads", async () => {
    const { handler: fileHandler } = createHandler();
    const client = new TestClient<ServerContext>();
    const chunks = [new Uint8Array([1]), new Uint8Array([2])];
    const tree = buildMerkleTree(chunks);
    const proofs = [generateMerkleProof(tree, 0), generateMerkleProof(tree, 1)];
    const root = getMerkleRoot(tree);

    const request = new FileMessage(
      {
        type: "file-request",
        direction: "upload",
        fileId: "file-resume",
        filename: "resume.bin",
        size: chunks.reduce((sum, c) => sum + c.length, 0),
        mimeType: "application/octet-stream",
        contentId: root,
        encrypted: false,
      },
      testContext,
    );
    await fileHandler.handle(request, client as unknown as any);
    const firstChunk = new FileMessage(
      {
        type: "file-progress",
        fileId: "file-resume",
        chunkIndex: 0,
        chunkData: chunks[0],
        merkleProof: proofs[0],
        totalChunks: 2,
        bytesUploaded: chunks[0].length,
        encrypted: false,
      },
      testContext,
    );
    await fileHandler.handle(firstChunk, client as unknown as any);

    const resumeRequest = new FileMessage(
      {
        type: "file-request",
        direction: "upload",
        fileId: "file-resume",
        filename: "resume.bin",
        size: chunks.reduce((sum, c) => sum + c.length, 0),
        mimeType: "application/octet-stream",
        contentId: root,
        encrypted: false,
      },
      testContext,
    );
    await fileHandler.handle(resumeRequest, client as unknown as any);
    const resumeAck = client.sent.at(-1) as FileMessage<ServerContext>;
    expect(resumeAck.payload.resumeFromChunk).toBe(1);
  });
});

describe("FileTransferHandler downloads", () => {
  it("streams stored files to clients", async () => {
    const { handler: fileHandler } = createHandler();
    const client = new TestClient<ServerContext>();
    const { chunk, proof, root } = createUploadPayload();

    const request = new FileMessage(
      {
        type: "file-request",
        direction: "upload",
        fileId: "file-download",
        filename: "download.bin",
        size: chunk.length,
        mimeType: "application/octet-stream",
        contentId: root,
        encrypted: false,
      },
      testContext,
    );
    await fileHandler.handle(request, client as unknown as any);
    const progress = new FileMessage(
      {
        type: "file-progress",
        fileId: "file-download",
        chunkIndex: 0,
        chunkData: chunk,
        merkleProof: proof,
        totalChunks: 1,
        bytesUploaded: chunk.length,
        encrypted: false,
      },
      testContext,
    );
    await fileHandler.handle(progress, client as unknown as any);

    const downloadClient = new TestClient<ServerContext>();
    const downloadRequest = new FileMessage(
      {
        type: "file-request",
        direction: "download",
        fileId: "download-session",
        filename: "ignored",
        size: 0,
        mimeType: "application/octet-stream",
        contentId: root,
      },
      testContext,
    );
    await fileHandler.handle(downloadRequest, downloadClient as unknown as any);
    expect(downloadClient.sent.length).toBeGreaterThan(1);
    const downloadAck = downloadClient.sent[0] as FileMessage<ServerContext>;
    expect(downloadAck.payload.status).toBe("accepted");
    const streamedChunk = downloadClient.sent[1] as FileMessage<ServerContext>;
    expect(streamedChunk.payload.type).toBe("file-progress");
    expect(streamedChunk.payload.chunkData.length).toBe(chunk.length);
  });
});
