import { describe, expect, it } from "bun:test";
import {
  buildMerkleTree,
  deserializeMerkleTree,
  generateMerkleProof,
  getMerkleRoot,
  serializeMerkleTree,
  verifyMerkleProof,
} from "./file-upload";
import { FileMessage } from "./message-types";
import { decodeMessage } from "./decode";
import { encodeMessage } from "./encode";

describe("file upload merkle utilities", () => {
  it("builds merkle tree and verifies proofs", () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const tree = buildMerkleTree(chunks);
    const proof = generateMerkleProof(tree, 1);
    const root = getMerkleRoot(tree);
    expect(verifyMerkleProof(chunks[1], proof, root, 1)).toBe(true);
  });

  it("serializes and deserializes trees", () => {
    const chunks = [new Uint8Array([7, 8, 9])];
    const tree = buildMerkleTree(chunks);
    const serialized = serializeMerkleTree(tree);
    const restored = deserializeMerkleTree(serialized, 1);
    expect(restored.nodes.length).toBe(tree.nodes.length);
    expect(restored.chunkCount).toBe(1);
  });
});

describe("file message encoding", () => {
  it("roundtrips file-request messages", () => {
    const contentId = new Uint8Array([1, 1, 1]);
    const request = new FileMessage(
      {
        type: "file-request",
        direction: "upload",
        fileId: "file-123",
        filename: "test.bin",
        size: 1024,
        mimeType: "application/octet-stream",
        contentId,
        status: "accepted",
        resumeFromChunk: 2,
        bytesUploaded: 2048,
        encrypted: true,
      },
      { userId: "user", room: "room", clientId: "client" },
      true,
    );
    const decoded = decodeMessage(encodeMessage(request));
    expect(decoded).toBeInstanceOf(FileMessage);
    if (decoded instanceof FileMessage) {
      expect(decoded.payload.status).toBe("accepted");
      expect(decoded.payload.encrypted).toBe(true);
      expect(decoded.payload.resumeFromChunk).toBe(2);
    }
  });

  it("roundtrips file-progress messages", () => {
    const progress = new FileMessage(
      {
        type: "file-progress",
        fileId: "file-123",
        chunkIndex: 0,
        chunkData: new Uint8Array([9, 9, 9]),
        merkleProof: [new Uint8Array([0])],
        totalChunks: 1,
        bytesUploaded: 3,
        encrypted: false,
      },
      { userId: "user", room: "room", clientId: "client" },
    );
    const decoded = decodeMessage(encodeMessage(progress));
    expect(decoded).toBeInstanceOf(FileMessage);
    if (decoded instanceof FileMessage) {
      expect(decoded.payload.type).toBe("file-progress");
      expect(decoded.payload.chunkData.length).toBe(3);
    }
  });
});
