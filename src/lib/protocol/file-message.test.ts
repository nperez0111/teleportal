import { describe, expect, it } from "bun:test";
import { decodeMessage, encodeMessage, FileMessage } from "./message-types";
import type { DecodedFileProgress, DecodedFileRequest } from "./types";

describe("File Message Encoding/Decoding", () => {
  it("should encode and decode file-request message", () => {
    const request: DecodedFileRequest = {
      type: "file-request",
      direction: "upload",
      fileId: "test-file-id",
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
    };

    const message = new FileMessage(request, {}, false);
    const encoded = encodeMessage(message);
    const decoded = decodeMessage(encoded);

    expect(decoded.type).toBe("file");
    expect(decoded.document).toBeUndefined();
    expect((decoded as FileMessage).payload.type).toBe("file-request");
    expect((decoded as FileMessage).payload.direction).toBe("upload");
    expect((decoded as FileMessage).payload.fileId).toBe("test-file-id");
    expect((decoded as FileMessage).payload.filename).toBe("test.txt");
    expect((decoded as FileMessage).payload.size).toBe(1024);
    expect((decoded as FileMessage).payload.mimeType).toBe("text/plain");
  });

  it("should encode and decode file-request with contentId", () => {
    const contentId = new Uint8Array(32).fill(123);
    const request: DecodedFileRequest = {
      type: "file-request",
      direction: "download",
      fileId: "test-file-id",
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      contentId,
    };

    const message = new FileMessage(request, {}, false);
    const encoded = encodeMessage(message);
    const decoded = decodeMessage(encoded);

    expect((decoded as FileMessage).payload.type).toBe("file-request");
    expect((decoded as FileMessage).payload.direction).toBe("download");
    expect((decoded as FileMessage).payload.contentId).toEqual(contentId);
  });

  it("should encode and decode file-progress message", () => {
    const chunkData = new Uint8Array(64 * 1024).fill(42);
    const merkleProof = [
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
    ];

    const progress: DecodedFileProgress = {
      type: "file-progress",
      fileId: "test-file-id",
      chunkIndex: 5,
      chunkData,
      merkleProof,
      totalChunks: 10,
      bytesUploaded: 320 * 1024,
      encrypted: false,
    };

    const message = new FileMessage(progress, {}, false);
    const encoded = encodeMessage(message);
    const decoded = decodeMessage(encoded);

    expect((decoded as FileMessage).payload.type).toBe("file-progress");
    expect((decoded as FileMessage).payload.fileId).toBe("test-file-id");
    expect((decoded as FileMessage).payload.chunkIndex).toBe(5);
    expect((decoded as FileMessage).payload.chunkData.length).toBe(chunkData.length);
    expect((decoded as FileMessage).payload.merkleProof.length).toBe(2);
    expect((decoded as FileMessage).payload.totalChunks).toBe(10);
    expect((decoded as FileMessage).payload.bytesUploaded).toBe(320 * 1024);
    expect((decoded as FileMessage).payload.encrypted).toBe(false);
  });

  it("should handle encrypted file messages", () => {
    const request: DecodedFileRequest = {
      type: "file-request",
      direction: "upload",
      fileId: "test-file-id",
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
    };

    const message = new FileMessage(request, {}, true);
    expect(message.encrypted).toBe(true);

    const encoded = encodeMessage(message);
    const decoded = decodeMessage(encoded);
    expect(decoded.encrypted).toBe(true);
  });
});
