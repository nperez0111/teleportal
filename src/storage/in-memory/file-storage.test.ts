import { describe, expect, it } from "bun:test";
import { InMemoryFileStorage } from "./file-storage";
import { File } from "../types";
import { toBase64 } from "lib0/buffer";

describe("InMemoryFileStorage", () => {
  it("should store and retrieve a file", async () => {
    const storage = new InMemoryFileStorage();
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

  it("should delete a file", async () => {
    const storage = new InMemoryFileStorage();
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
    await storage.deleteFile(fileId);

    const retrieved = await storage.getFile(fileId);
    expect(retrieved).toBeNull();
  });
});
