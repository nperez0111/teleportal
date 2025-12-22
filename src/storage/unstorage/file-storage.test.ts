import { describe, expect, it, beforeEach } from "bun:test";
import { createStorage } from "unstorage";
import { UnstorageFileStorage } from "./file-storage";
import { toBase64 } from "lib0/buffer";
import { File } from "../types";

describe("UnstorageFileStorage", () => {
  let storage: UnstorageFileStorage;
  let unstorage: any;

  beforeEach(() => {
    unstorage = createStorage();
    storage = new UnstorageFileStorage(unstorage);
  });

  it("should store and retrieve a file", async () => {
    const contentId = new Uint8Array([1, 2, 3]);
    const fileId = toBase64(contentId);
    const file: File = {
      id: fileId,
      metadata: {
        filename: "test.txt",
        size: 3,
        mimeType: "text/plain",
        encrypted: false,
        lastModified: Date.now(),
        documentId: "doc1",
      },
      chunks: [new Uint8Array([1, 2, 3])],
      contentId,
    };

    await storage.storeFile(file);

    const retrieved = await storage.getFile(fileId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(fileId);
    expect(retrieved!.chunks[0]).toEqual(file.chunks[0]);
  });

  it("should persist data across storage instances", async () => {
    const contentId = new Uint8Array([1, 2, 3]);
    const fileId = toBase64(contentId);
    const file: File = {
      id: fileId,
      metadata: {
        filename: "test.txt",
        size: 3,
        mimeType: "text/plain",
        encrypted: false,
        lastModified: Date.now(),
        documentId: "doc1",
      },
      chunks: [new Uint8Array([1, 2, 3])],
      contentId,
    };

    await storage.storeFile(file);

    const storage2 = new UnstorageFileStorage(unstorage);
    const retrieved = await storage2.getFile(fileId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(fileId);
  });
});
