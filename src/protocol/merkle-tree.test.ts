import { describe, expect, it } from "bun:test";
import {
  generateMerkleContentId,
  buildMerkleTreeMetadata,
  verifyMerkleTree,
  createMerkleTreeSegments,
  reconstructMerkleTreeFromSegments,
  getMerkleProof,
  verifyMerkleProof,
  BLAKE_CHUNK_SIZE,
} from "./merkle-tree";

describe("Merkle Tree Implementation", () => {
  describe("Basic Merkle Tree Operations", () => {
    it("should generate consistent content IDs for the same data", () => {
      const data1 = new Uint8Array([1, 2, 3, 4, 5]);
      const data2 = new Uint8Array([1, 2, 3, 4, 5]);
      
      const contentId1 = generateMerkleContentId(data1);
      const contentId2 = generateMerkleContentId(data2);
      
      expect(contentId1).toBe(contentId2);
      expect(contentId1).toBeTruthy();
    });

    it("should generate different content IDs for different data", () => {
      const data1 = new Uint8Array([1, 2, 3, 4, 5]);
      const data2 = new Uint8Array([1, 2, 3, 4, 6]);
      
      const contentId1 = generateMerkleContentId(data1);
      const contentId2 = generateMerkleContentId(data2);
      
      expect(contentId1).not.toBe(contentId2);
    });

    it("should handle empty data", () => {
      const emptyData = new Uint8Array(0);
      const contentId = generateMerkleContentId(emptyData);
      
      expect(contentId).toBeTruthy();
      expect(typeof contentId).toBe("string");
    });

    it("should build merkle tree metadata correctly", () => {
      const data = new Uint8Array(BLAKE_CHUNK_SIZE * 2.5); // 2.5 chunks
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }
      
      const metadata = buildMerkleTreeMetadata(data);
      
      expect(metadata.fileSize).toBe(data.length);
      expect(metadata.totalChunks).toBe(3); // 2.5 chunks rounded up
      expect(metadata.rootHash).toBeTruthy();
      expect(metadata.treeDepth).toBeGreaterThan(0);
      expect(metadata.leafHashes).toHaveLength(3);
    });
  });

  describe("Merkle Tree Verification", () => {
    it("should verify correct merkle tree", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const metadata = buildMerkleTreeMetadata(data);
      
      const isValid = verifyMerkleTree(data, metadata);
      expect(isValid).toBe(true);
    });

    it("should reject corrupted data", () => {
      const originalData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const metadata = buildMerkleTreeMetadata(originalData);
      
      const corruptedData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 11]); // Changed last byte
      
      const isValid = verifyMerkleTree(corruptedData, metadata);
      expect(isValid).toBe(false);
    });

    it("should reject tampered metadata", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const metadata = buildMerkleTreeMetadata(data);
      
      // Tamper with root hash
      const tamperedMetadata = {
        ...metadata,
        rootHash: metadata.rootHash.slice(0, -2) + "00",
      };
      
      const isValid = verifyMerkleTree(data, tamperedMetadata);
      expect(isValid).toBe(false);
    });
  });

  describe("Merkle Tree Segments", () => {
    it("should create and reconstruct segments correctly", () => {
      const data = new Uint8Array(BLAKE_CHUNK_SIZE * 10); // 10 chunks
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }
      
      const maxSegmentSize = BLAKE_CHUNK_SIZE * 3; // 3 chunks per segment
      const segments = createMerkleTreeSegments(data, maxSegmentSize);
      
      expect(segments.length).toBe(4); // ceil(10/3) = 4 segments
      
      // Verify each segment has correct metadata
      for (const segment of segments) {
        expect(segment.merkleMetadata.fileSize).toBe(data.length);
        expect(segment.merkleMetadata.rootHash).toBe(segments[0].merkleMetadata.rootHash);
        expect(segment.chunkHashes.length).toBeGreaterThan(0);
      }
      
      // Reconstruct metadata from segments
      const reconstructedMetadata = reconstructMerkleTreeFromSegments(segments);
      expect(reconstructedMetadata).toBeTruthy();
      expect(reconstructedMetadata!.rootHash).toBe(segments[0].merkleMetadata.rootHash);
    });

    it("should handle single segment files", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const maxSegmentSize = 1000;
      
      const segments = createMerkleTreeSegments(data, maxSegmentSize);
      
      expect(segments.length).toBe(1);
      expect(segments[0].segmentIndex).toBe(0);
      expect(segments[0].totalSegments).toBe(1);
    });

    it("should reject inconsistent segments", () => {
      const data = new Uint8Array(BLAKE_CHUNK_SIZE * 6);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }
      
      const segments = createMerkleTreeSegments(data, BLAKE_CHUNK_SIZE * 2);
      
      // Corrupt one segment's metadata
      segments[1].merkleMetadata.rootHash = "corrupted_hash";
      
      const reconstructedMetadata = reconstructMerkleTreeFromSegments(segments);
      expect(reconstructedMetadata).toBeNull();
    });
  });

  describe("Merkle Proofs", () => {
    it("should generate and verify valid merkle proofs", () => {
      const data = new Uint8Array(BLAKE_CHUNK_SIZE * 8); // 8 chunks
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }
      
      const metadata = buildMerkleTreeMetadata(data);
      
      // Test proof for each chunk
      for (let chunkIndex = 0; chunkIndex < metadata.totalChunks; chunkIndex++) {
        const proof = getMerkleProof(metadata.leafHashes, chunkIndex);
        const isValid = verifyMerkleProof(
          metadata.leafHashes[chunkIndex],
          chunkIndex,
          proof,
          metadata.rootHash,
        );
        
        expect(isValid).toBe(true);
      }
    });

    it("should reject invalid merkle proofs", () => {
      const data = new Uint8Array(BLAKE_CHUNK_SIZE * 4);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }
      
      const metadata = buildMerkleTreeMetadata(data);
      
      const proof = getMerkleProof(metadata.leafHashes, 0);
      
      // Test with wrong chunk hash
      const wrongChunkHash = metadata.leafHashes[1];
      const isValid = verifyMerkleProof(wrongChunkHash, 0, proof, metadata.rootHash);
      expect(isValid).toBe(false);
      
      // Test with wrong root hash
      const wrongRootHash = metadata.rootHash.slice(0, -2) + "00";
      const isValid2 = verifyMerkleProof(
        metadata.leafHashes[0],
        0,
        proof,
        wrongRootHash,
      );
      expect(isValid2).toBe(false);
    });

    it("should handle edge cases in proof generation", () => {
      // Single chunk
      const singleChunkData = new Uint8Array([1, 2, 3]);
      const singleMetadata = buildMerkleTreeMetadata(singleChunkData);
      
      const singleProof = getMerkleProof(singleMetadata.leafHashes, 0);
      expect(singleProof).toHaveLength(0); // No siblings for single node
      
      const singleValid = verifyMerkleProof(
        singleMetadata.leafHashes[0],
        0,
        singleProof,
        singleMetadata.rootHash,
      );
      expect(singleValid).toBe(true);
    });
  });

  describe("Large File Handling", () => {
    it("should handle large files efficiently", () => {
      const largeData = new Uint8Array(BLAKE_CHUNK_SIZE * 100); // 100 chunks
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256;
      }
      
      const startTime = Date.now();
      const metadata = buildMerkleTreeMetadata(largeData);
      const endTime = Date.now();
      
      expect(metadata.totalChunks).toBe(100);
      expect(metadata.fileSize).toBe(largeData.length);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete in under 1 second
      
      // Verify the tree
      const isValid = verifyMerkleTree(largeData, metadata);
      expect(isValid).toBe(true);
    });

    it("should maintain consistency across different chunk boundaries", () => {
      // Test that the same data produces the same merkle tree regardless of how it's processed
      const testData = new Uint8Array(BLAKE_CHUNK_SIZE * 7 + 500); // Non-aligned size
      for (let i = 0; i < testData.length; i++) {
        testData[i] = (i * 3 + 7) % 256;
      }
      
      const metadata1 = buildMerkleTreeMetadata(testData);
      const metadata2 = buildMerkleTreeMetadata(testData);
      
      expect(metadata1.rootHash).toBe(metadata2.rootHash);
      expect(metadata1.totalChunks).toBe(metadata2.totalChunks);
      expect(metadata1.leafHashes).toEqual(metadata2.leafHashes);
    });
  });
});