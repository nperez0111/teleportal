import { describe, expect, it } from "bun:test";
import { decodeMessage } from "./decode";
import { FileMessage } from "./message-types";
import { CHUNK_SIZE } from "../merkle-tree/merkle-tree";
import type {
  DecodedFileAuthMessage,
  DecodedFileProgress,
  DecodedFileRequest,
} from "./types";
import { toBase64 } from "lib0/buffer";

describe("File Message Encoding/Decoding", () => {
  it("should encode and decode file-request (upload)", () => {
    const message = new FileMessage<Record<string, unknown>>(
      {
        type: "file-request",
        direction: "upload",
        fileId: "test-file-id",
        filename: "test.txt",
        size: 1024,
        mimeType: "text/plain",
      },
      {},
      false,
    );

    const decoded = decodeMessage(message.encoded) as FileMessage<
      Record<string, unknown>
    >;

    expect(decoded.type).toBe("file");
    expect(decoded.document).toBeUndefined();
    expect(decoded.payload.type).toBe("file-request");
    const payload = decoded.payload as DecodedFileRequest;
    expect(payload.direction).toBe("upload");
    expect(payload.fileId).toBe("test-file-id");
    expect(payload.filename).toBe("test.txt");
    expect(payload.size).toBe(1024);
    expect(payload.mimeType).toBe("text/plain");
  });

  it("should encode and decode file-request (download)", () => {
    const contentId = new Uint8Array(32);
    contentId.fill(42);
    const fileId = toBase64(contentId);

    const message = new FileMessage<Record<string, unknown>>(
      {
        type: "file-request",
        direction: "download",
        fileId,
        filename: "test.txt",
        size: 1024,
        mimeType: "text/plain",
      },
      {},
      false,
    );

    const decoded = decodeMessage(message.encoded) as FileMessage<
      Record<string, unknown>
    >;

    expect(decoded.type).toBe("file");
    const payload = decoded.payload as DecodedFileRequest;
    expect(payload.direction).toBe("download");
    expect(payload.fileId).toBe(fileId);
  });

  it("should encode and decode file-progress", () => {
    const chunkData = new Uint8Array(CHUNK_SIZE);
    chunkData.fill(1);

    const merkleProof = [
      new Uint8Array(32).fill(2),
      new Uint8Array(32).fill(3),
    ];

    const message = new FileMessage<Record<string, unknown>>(
      {
        type: "file-progress",
        fileId: "test-file-id",
        chunkIndex: 0,
        chunkData,
        merkleProof,
        totalChunks: 10,
        bytesUploaded: CHUNK_SIZE,
        encrypted: false,
      },
      {},
      false,
    );

    const decoded = decodeMessage(message.encoded) as FileMessage<
      Record<string, unknown>
    >;

    expect(decoded.type).toBe("file");
    const payload = decoded.payload as DecodedFileProgress;
    expect(payload.type).toBe("file-progress");
    expect(payload.fileId).toBe("test-file-id");
    expect(payload.chunkIndex).toBe(0);
    expect(payload.chunkData.length).toBe(CHUNK_SIZE);
    expect(payload.merkleProof.length).toBe(2);
    expect(payload.totalChunks).toBe(10);
    expect(payload.bytesUploaded).toBe(CHUNK_SIZE);
    expect(payload.encrypted).toBe(false);
  });

  it("should handle encrypted file messages", () => {
    const message = new FileMessage<Record<string, unknown>>(
      {
        type: "file-request",
        direction: "upload",
        fileId: "test-file-id",
        filename: "test.txt",
        size: 1024,
        mimeType: "text/plain",
      },
      {},
      true,
    );

    const decoded = decodeMessage(message.encoded) as FileMessage<
      Record<string, unknown>
    >;

    expect(decoded.encrypted).toBe(true);
  });

  it("should encode and decode file-auth-message", () => {
    const message = new FileMessage<Record<string, unknown>>({
      type: "file-auth-message",
      permission: "denied",
      reason: "test",
    });
    const decoded = decodeMessage(message.encoded) as FileMessage<
      Record<string, unknown>
    >;
    expect(decoded.type).toBe("file");
    const payload = decoded.payload as DecodedFileAuthMessage;
    expect(payload.type).toBe("file-auth-message");
    expect(payload.permission).toBe("denied");
    expect(payload.reason).toBe("test");
  });
});
