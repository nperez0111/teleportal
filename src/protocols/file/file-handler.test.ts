import { describe, expect, it } from "bun:test";
import { toBase64 } from "lib0/buffer";
import {
  AckMessage,
  type Message,
  type RpcServerContext,
  type ServerContext,
} from "teleportal";
import {
  buildMerkleTree,
  CHUNK_SIZE,
  generateMerkleProof,
} from "teleportal/merkle-tree";
import { InMemoryFileStorage } from "../../storage/in-memory/file-storage";
import { InMemoryTemporaryUploadStorage } from "../../storage/in-memory/temporary-upload-storage";
import { YDocStorage } from "../../storage/in-memory/ydoc";
import type { DocumentStorage } from "../../storage/types";
import type { FilePartStream } from "./methods";
import { FileHandler } from "./server-handlers";

function createMockContext(
  documentId: string,
  storage: DocumentStorage,
): RpcServerContext {
  return {
    documentId,
    session: {
      storage,
    } as any,
    server: {} as any,
  };
}

describe("FileHandler", () => {
  it("initiates upload via temporary upload storage", async () => {
    const fileStorage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage();
    fileStorage.temporaryUploadStorage = temp;

    const fileHandler = new FileHandler(fileStorage);

    const chunks = [new Uint8Array([1, 2, 3])];
    const fileId = toBase64(buildMerkleTree(chunks).nodes.at(-1)!.hash!);

    await fileHandler.initiateUpload(
      fileId,
      {
        filename: "test.txt",
        size: 3,
        mimeType: "text/plain",
        encrypted: false,
      },
      "test-doc",
    );

    const progress = await temp.getUploadProgress(fileId);
    expect(progress).not.toBeNull();
    expect(progress!.metadata.filename).toBe("test.txt");
    expect(progress!.metadata.size).toBe(3);
  });

  it("acks file parts and completes upload when all chunks arrive", async () => {
    const fileStorage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage();
    fileStorage.temporaryUploadStorage = temp;

    const documentStorage = new YDocStorage();
    const documentId = "test-doc";
    const context = createMockContext(documentId, documentStorage);

    const fileHandler = new FileHandler(fileStorage);

    const chunk1 = new Uint8Array(CHUNK_SIZE);
    chunk1.fill(1);
    const chunk2 = new Uint8Array(100);
    chunk2.fill(2);
    const chunks = [chunk1, chunk2];
    const fileId = toBase64(buildMerkleTree(chunks).nodes.at(-1)!.hash!);

    await temp.beginUpload(fileId, {
      filename: "test.txt",
      size: chunk1.length + chunk2.length,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId,
    });

    const sent: Message<ServerContext>[] = [];

    const proof0 = generateMerkleProof(buildMerkleTree(chunks), 0);
    const part0: FilePartStream = {
      fileId,
      chunkIndex: 0,
      chunkData: chunk1,
      merkleProof: proof0,
      totalChunks: 2,
      bytesUploaded: chunk1.length,
      encrypted: false,
    };

    await fileHandler.handleFilePart(
      part0,
      "message-id-0",
      async (m) => {
        sent.push(m);
      },
      context,
    );

    expect(sent.length).toBe(1);
    expect((sent[0] as AckMessage<ServerContext>).payload.type).toBe("ack");
    sent.length = 0;

    const p1 = await temp.getUploadProgress(fileId);
    expect(p1).not.toBeNull();
    expect(p1!.chunks.get(0)).toBe(true);

    const proof1 = generateMerkleProof(buildMerkleTree(chunks), 1);
    const part1: FilePartStream = {
      fileId,
      chunkIndex: 1,
      chunkData: chunk2,
      merkleProof: proof1,
      totalChunks: 2,
      bytesUploaded: chunk1.length + chunk2.length,
      encrypted: false,
    };

    await fileHandler.handleFilePart(
      part1,
      "message-id-1",
      async (m) => {
        sent.push(m);
      },
      context,
    );
    expect(sent.length).toBe(1);
    expect((sent[0] as AckMessage<ServerContext>).payload.type).toBe("ack");

    const file = await fileStorage.getFile(fileId);
    expect(file).not.toBeNull();
    expect(file!.chunks.length).toBe(2);

    // Verify document metadata was updated with the file
    const metadata = await documentStorage.getDocumentMetadata(documentId);
    expect(metadata.files).toContain(fileId);
  });

  it("serves downloads from file storage via streamFileParts generator", async () => {
    const fileStorage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage();
    fileStorage.temporaryUploadStorage = temp;

    const fileHandler = new FileHandler(fileStorage);

    const chunks = [new Uint8Array([1, 2, 3])];
    const fileId = toBase64(buildMerkleTree(chunks).nodes.at(-1)!.hash!);

    await temp.beginUpload(fileId, {
      filename: "test.txt",
      size: 3,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });
    await temp.storeChunk(fileId, 0, chunks[0], []);
    const result = await temp.completeUpload(fileId, fileId);
    await fileStorage.storeFileFromUpload(result);

    // streamFileParts is now an async generator
    const parts: import("./methods").FilePartStream[] = [];
    for await (const part of fileHandler.streamFileParts(fileId)) {
      parts.push(part);
    }

    expect(parts.length).toBe(1);
    expect(parts[0].fileId).toBe(fileId);
    expect(parts[0].chunkIndex).toBe(0);
    expect(parts[0].totalChunks).toBe(1);
    expect(parts[0].chunkData).toEqual(chunks[0]);
  });
});
