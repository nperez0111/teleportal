import { describe, expect, it } from "bun:test";
import { toBase64 } from "lib0/buffer";
import {
  AckMessage,
  FileMessage,
  type Message,
  type ServerContext,
} from "teleportal";
import {
  buildMerkleTree,
  CHUNK_SIZE,
  generateMerkleProof,
} from "../lib/merkle-tree/merkle-tree";
import { InMemoryFileStorage } from "../storage/in-memory/file-storage";
import { InMemoryTemporaryUploadStorage } from "../storage/in-memory/temporary-upload-storage";
import { FileHandler } from "./file-handler";

describe("FileHandler", () => {
  it("initiates upload via temporary upload storage", async () => {
    const fileStorage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage();
    fileStorage.temporaryUploadStorage = temp;

    const fileHandler = new FileHandler(fileStorage);

    const chunks = [new Uint8Array([1, 2, 3])];
    const fileId = toBase64(buildMerkleTree(chunks).nodes.at(-1)!.hash!);

    const sent: Message<ServerContext>[] = [];
    await fileHandler.handle(
      new FileMessage<ServerContext>("test-doc", {
        type: "file-upload",
        fileId,
        filename: "test.txt",
        size: 3,
        mimeType: "text/plain",
        lastModified: Date.now(),
        encrypted: false,
      }),
      async (m) => {
        sent.push(m);
      },
    );

    // Protocol responds with a file-download message as an "authorization" step
    expect(sent.length).toBe(1);
    const auth = sent[0] as FileMessage<ServerContext>;
    expect(auth.payload.type).toBe("file-download");
    expect((auth.payload as any).fileId).toBe(fileId);

    const progress = await temp.getUploadProgress(fileId);
    expect(progress).not.toBeNull();
    expect(progress!.metadata.filename).toBe("test.txt");
    expect(progress!.metadata.size).toBe(3);
  });

  it("acks file parts and completes upload when all chunks arrive", async () => {
    const fileStorage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage();
    fileStorage.temporaryUploadStorage = temp;

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
      documentId: "test-doc",
    });

    const sent: Message<ServerContext>[] = [];

    // Send first chunk
    const proof0 = generateMerkleProof(buildMerkleTree(chunks), 0);
    const part0 = new FileMessage<ServerContext>("test-doc", {
      type: "file-part",
      fileId,
      chunkIndex: 0,
      chunkData: chunk1,
      merkleProof: proof0,
      totalChunks: 2,
      bytesUploaded: chunk1.length,
      encrypted: false,
    });

    await fileHandler.handle(part0, async (m) => {
      sent.push(m);
    });

    expect(sent.length).toBe(1);
    expect((sent[0] as AckMessage<ServerContext>).payload.type).toBe("ack");
    sent.length = 0;

    const p1 = await temp.getUploadProgress(fileId);
    expect(p1).not.toBeNull();
    expect(p1!.chunks.get(0)).toBe(true);

    // Send second (final) chunk
    const proof1 = generateMerkleProof(buildMerkleTree(chunks), 1);
    const part1 = new FileMessage<ServerContext>("test-doc", {
      type: "file-part",
      fileId,
      chunkIndex: 1,
      chunkData: chunk2,
      merkleProof: proof1,
      totalChunks: 2,
      bytesUploaded: chunk1.length + chunk2.length,
      encrypted: false,
    });

    await fileHandler.handle(part1, async (m) => {
      sent.push(m);
    });
    expect(sent.length).toBe(1);
    expect((sent[0] as AckMessage<ServerContext>).payload.type).toBe("ack");

    // File should now be stored and downloadable
    const file = await fileStorage.getFile(fileId);
    expect(file).not.toBeNull();
    expect(file!.chunks.length).toBe(2);
  });

  it("serves downloads from file storage", async () => {
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

    const sent: Message<ServerContext>[] = [];
    await fileHandler.handle(
      new FileMessage<ServerContext>("test-doc", {
        type: "file-download",
        fileId,
      }),
      async (m) => {
        sent.push(m);
      },
    );

    // First message: file-upload preamble, then one file-part
    expect(sent.length).toBe(2);
    expect((sent[0] as FileMessage<ServerContext>).payload.type).toBe(
      "file-upload",
    );
    expect((sent[1] as FileMessage<ServerContext>).payload.type).toBe(
      "file-part",
    );
  });
});
