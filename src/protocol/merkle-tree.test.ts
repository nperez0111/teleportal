import { describe, expect, it, beforeEach } from "bun:test";
import {
  generateMerkleContentId,
  buildMerkleTreeMetadata,
  verifyMerkleTree,
  createMerkleTreeSegments,
  reconstructMerkleTreeFromSegments,
  getMerkleProof,
  verifyMerkleProof,
  CHUNK_SIZE,
  MAX_TREE_DEPTH,
  type MerkleTreeMetadata,
  type MerkleTreeSegment,
} from "./merkle-tree";

describe("Merkle Tree Implementation", () => {
  let testData: Uint8Array;
  let largeTestData: Uint8Array;
  let emptyData: Uint8Array;

  beforeEach(() => {
    // Small test data (less than one chunk)
    testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    
    // Large test data (multiple chunks)
    largeTestData = new Uint8Array(CHUNK_SIZE * 5 + 500); // 5.5 chunks
    for (let i = 0; i < largeTestData.length; i++) {
      largeTestData[i] = (i * 7 + 13) % 256;
    }
    
    // Empty data
    emptyData = new Uint8Array(0);
  });

  describe("Content ID Generation", () => {
    it("should generate base64-encoded content IDs", () => {
      const contentId = generateMerkleContentId(testData);
      
      expect(typeof contentId).toBe("string");
      expect(contentId.length).toBeGreaterThan(0);
      
      // Should be valid base64
      expect(() => atob(contentId)).not.toThrow();
    });

    it("should generate deterministic content IDs", () => {
      const contentId1 = generateMerkleContentId(testData);
      const contentId2 = generateMerkleContentId(testData);
      
      expect(contentId1).toBe(contentId2);
    });

    it("should generate different content IDs for different data", () => {
      const data1 = new Uint8Array([1, 2, 3, 4, 5]);
      const data2 = new Uint8Array([1, 2, 3, 4, 6]);
      
      const contentId1 = generateMerkleContentId(data1);
      const contentId2 = generateMerkleContentId(data2);
      
      expect(contentId1).not.toBe(contentId2);
    });

    it("should handle empty data gracefully", () => {
      const contentId = generateMerkleContentId(emptyData);
      
      expect(typeof contentId).toBe("string");
      expect(contentId.length).toBeGreaterThan(0);
    });

    it("should handle single byte data", () => {
      const singleByte = new Uint8Array([42]);
      const contentId = generateMerkleContentId(singleByte);
      
      expect(typeof contentId).toBe("string");
      expect(contentId.length).toBeGreaterThan(0);
    });
  });

  describe("Merkle Tree Metadata", () => {
    it("should build correct metadata for small files", () => {
      const metadata = buildMerkleTreeMetadata(testData);
      
      expect(metadata.fileSize).toBe(testData.length);
      expect(metadata.totalChunks).toBe(1); // Small file fits in one chunk
      expect(metadata.treeDepth).toBe(1); // Single leaf = depth 1
      expect(metadata.rootHash).toBeTruthy();
      expect(metadata.leafHashes).toHaveLength(1);
      expect(metadata.rootHash).toBe(metadata.leafHashes[0]); // Root equals single leaf
    });

    it("should build correct metadata for multi-chunk files", () => {
      const metadata = buildMerkleTreeMetadata(largeTestData);
      
      expect(metadata.fileSize).toBe(largeTestData.length);
      expect(metadata.totalChunks).toBe(6); // 5.5 chunks rounded up
      expect(metadata.treeDepth).toBeGreaterThan(1);
      expect(metadata.rootHash).toBeTruthy();
      expect(metadata.leafHashes).toHaveLength(6);
      expect(metadata.rootHash).not.toBe(metadata.leafHashes[0]); // Root != single leaf
    });

    it("should build correct metadata for empty files", () => {
      const metadata = buildMerkleTreeMetadata(emptyData);
      
      expect(metadata.fileSize).toBe(0);
      expect(metadata.totalChunks).toBe(1); // At least one chunk even for empty
      expect(metadata.treeDepth).toBe(1);
      expect(metadata.rootHash).toBeTruthy();
      expect(metadata.leafHashes).toHaveLength(1);
    });

    it("should handle exact chunk boundary sizes", () => {
      const exactChunkData = new Uint8Array(CHUNK_SIZE * 3); // Exactly 3 chunks
      for (let i = 0; i < exactChunkData.length; i++) {
        exactChunkData[i] = i % 256;
      }
      
      const metadata = buildMerkleTreeMetadata(exactChunkData);
      
      expect(metadata.totalChunks).toBe(3);
      expect(metadata.leafHashes).toHaveLength(3);
    });
  });

  describe("Tree Verification", () => {
    it("should verify correct merkle trees", () => {
      const metadata = buildMerkleTreeMetadata(testData);
      const isValid = verifyMerkleTree(testData, metadata);
      
      expect(isValid).toBe(true);
    });

    it("should verify correct merkle trees for large files", () => {
      const metadata = buildMerkleTreeMetadata(largeTestData);
      const isValid = verifyMerkleTree(largeTestData, metadata);
      
      expect(isValid).toBe(true);
    });

    it("should reject corrupted data", () => {
      const metadata = buildMerkleTreeMetadata(testData);
      const corruptedData = new Uint8Array([...testData]);
      corruptedData[0] = 255; // Corrupt first byte
      
      const isValid = verifyMerkleTree(corruptedData, metadata);
      
      expect(isValid).toBe(false);
    });

    it("should reject tampered metadata", () => {
      const metadata = buildMerkleTreeMetadata(testData);
      const tamperedMetadata: MerkleTreeMetadata = {
        ...metadata,
        rootHash: "dGFtcGVyZWRfaGFzaA==", // "tampered_hash" in base64
      };
      
      const isValid = verifyMerkleTree(testData, tamperedMetadata);
      
      expect(isValid).toBe(false);
    });

    it("should reject metadata with wrong file size", () => {
      const metadata = buildMerkleTreeMetadata(testData);
      const wrongMetadata: MerkleTreeMetadata = {
        ...metadata,
        fileSize: metadata.fileSize + 1,
      };
      
      const isValid = verifyMerkleTree(testData, wrongMetadata);
      
      expect(isValid).toBe(false);
    });

    it("should reject metadata with wrong chunk count", () => {
      const metadata = buildMerkleTreeMetadata(testData);
      const wrongMetadata: MerkleTreeMetadata = {
        ...metadata,
        totalChunks: metadata.totalChunks + 1,
      };
      
      const isValid = verifyMerkleTree(testData, wrongMetadata);
      
      expect(isValid).toBe(false);
    });
  });

  describe("Merkle Tree Segments", () => {
    it("should create correct segments for large files", () => {
      const maxSegmentSize = CHUNK_SIZE * 2; // 2 chunks per segment
      const segments = createMerkleTreeSegments(largeTestData, maxSegmentSize);
      
      expect(segments.length).toBe(3); // ceil(5.5/2) = 3 segments
      
      // Verify segment metadata consistency
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        expect(segment.segmentIndex).toBe(i);
        expect(segment.totalSegments).toBe(3);
        expect(segment.merkleMetadata.fileSize).toBe(largeTestData.length);
        expect(segment.chunkHashes.length).toBeGreaterThan(0);
        
        // All segments should have same root hash
        expect(segment.merkleMetadata.rootHash).toBe(segments[0].merkleMetadata.rootHash);
      }
    });

    it("should handle single segment files", () => {
      const maxSegmentSize = CHUNK_SIZE * 10; // Larger than test data
      const segments = createMerkleTreeSegments(testData, maxSegmentSize);
      
      expect(segments.length).toBe(1);
      expect(segments[0].segmentIndex).toBe(0);
      expect(segments[0].totalSegments).toBe(1);
      expect(segments[0].startChunkIndex).toBe(0);
      expect(segments[0].endChunkIndex).toBe(0);
    });

    it("should create segments with correct chunk ranges", () => {
      const maxSegmentSize = CHUNK_SIZE * 2; // 2 chunks per segment
      const segments = createMerkleTreeSegments(largeTestData, maxSegmentSize);
      
      // Verify chunk index ranges don't overlap and cover all chunks
      let expectedStartIndex = 0;
      for (const segment of segments) {
        expect(segment.startChunkIndex).toBe(expectedStartIndex);
        expect(segment.endChunkIndex).toBeGreaterThanOrEqual(segment.startChunkIndex);
        expectedStartIndex = segment.endChunkIndex + 1;
      }
    });

    it("should reconstruct metadata from consistent segments", () => {
      const maxSegmentSize = CHUNK_SIZE * 2;
      const segments = createMerkleTreeSegments(largeTestData, maxSegmentSize);
      
      const reconstructed = reconstructMerkleTreeFromSegments(segments);
      
      expect(reconstructed).not.toBeNull();
      expect(reconstructed!.rootHash).toBe(segments[0].merkleMetadata.rootHash);
      expect(reconstructed!.fileSize).toBe(largeTestData.length);
      expect(reconstructed!.totalChunks).toBe(6);
    });

    it("should reject inconsistent segments", () => {
      const maxSegmentSize = CHUNK_SIZE * 2;
      const segments = createMerkleTreeSegments(largeTestData, maxSegmentSize);
      
      // Corrupt one segment's metadata
      segments[1].merkleMetadata.rootHash = "Y29ycnVwdGVkX2hhc2g="; // "corrupted_hash" in base64
      
      const reconstructed = reconstructMerkleTreeFromSegments(segments);
      
      expect(reconstructed).toBeNull();
    });

    it("should handle empty segment arrays", () => {
      const reconstructed = reconstructMerkleTreeFromSegments([]);
      
      expect(reconstructed).toBeNull();
    });
  });

  describe("Merkle Proofs", () => {
    it("should generate and verify proofs for single chunk", () => {
      const metadata = buildMerkleTreeMetadata(testData);
      
      const proof = getMerkleProof(metadata.leafHashes, 0);
      const isValid = verifyMerkleProof(
        metadata.leafHashes[0],
        0,
        proof,
        metadata.rootHash
      );
      
      expect(proof).toHaveLength(0); // No siblings for single chunk
      expect(isValid).toBe(true);
    });

    it("should generate and verify proofs for multi-chunk files", () => {
      const metadata = buildMerkleTreeMetadata(largeTestData);
      
      // Test proof for each chunk
      for (let i = 0; i < metadata.totalChunks; i++) {
        const proof = getMerkleProof(metadata.leafHashes, i);
        const isValid = verifyMerkleProof(
          metadata.leafHashes[i],
          i,
          proof,
          metadata.rootHash
        );
        
        expect(isValid).toBe(true);
        expect(proof.length).toBeGreaterThan(0); // Should have siblings
      }
    });

    it("should reject invalid merkle proofs", () => {
      const metadata = buildMerkleTreeMetadata(largeTestData);
      
      const proof = getMerkleProof(metadata.leafHashes, 0);
      
      // Test with wrong chunk hash
      const wrongChunkHash = metadata.leafHashes[1];
      const isValid1 = verifyMerkleProof(wrongChunkHash, 0, proof, metadata.rootHash);
      expect(isValid1).toBe(false);
      
      // Test with wrong chunk index
      const isValid2 = verifyMerkleProof(metadata.leafHashes[0], 1, proof, metadata.rootHash);
      expect(isValid2).toBe(false);
      
      // Test with wrong root hash
      const wrongRootHash = "d3Jvbmdfcm9vdF9oYXNo"; // "wrong_root_hash" in base64
      const isValid3 = verifyMerkleProof(metadata.leafHashes[0], 0, proof, wrongRootHash);
      expect(isValid3).toBe(false);
    });

    it("should handle out-of-bounds chunk indices", () => {
      const metadata = buildMerkleTreeMetadata(testData);
      
      expect(() => getMerkleProof(metadata.leafHashes, 999)).toThrow("Target chunk index out of bounds");
      expect(() => getMerkleProof(metadata.leafHashes, -1)).toThrow("Target chunk index out of bounds");
    });

    it("should handle corrupted proof data gracefully", () => {
      const metadata = buildMerkleTreeMetadata(largeTestData);
      const validProof = getMerkleProof(metadata.leafHashes, 0);
      
      // Test with corrupted proof
      const corruptedProof = [...validProof];
      corruptedProof[0] = "Y29ycnVwdGVk"; // "corrupted" in base64
      
      const isValid = verifyMerkleProof(
        metadata.leafHashes[0],
        0,
        corruptedProof,
        metadata.rootHash
      );
      
      expect(isValid).toBe(false);
    });
  });

  describe("Performance and Edge Cases", () => {
    it("should handle very large files efficiently", () => {
      const veryLargeData = new Uint8Array(CHUNK_SIZE * 1000); // 1000 chunks (~1MB)
      for (let i = 0; i < veryLargeData.length; i++) {
        veryLargeData[i] = i % 256;
      }
      
      const startTime = performance.now();
      const metadata = buildMerkleTreeMetadata(veryLargeData);
      const endTime = performance.now();
      
      expect(metadata.totalChunks).toBe(1000);
      expect(metadata.fileSize).toBe(veryLargeData.length);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete in under 1 second
      
      // Verify the tree
      const isValid = verifyMerkleTree(veryLargeData, metadata);
      expect(isValid).toBe(true);
    });

    it("should respect maximum tree depth", () => {
      // This would create a very deep tree, but should be limited
      const metadata = buildMerkleTreeMetadata(largeTestData);
      
      expect(metadata.treeDepth).toBeLessThanOrEqual(MAX_TREE_DEPTH);
    });

    it("should maintain consistency across multiple operations", () => {
      // Generate metadata multiple times for same data
      const metadata1 = buildMerkleTreeMetadata(testData);
      const metadata2 = buildMerkleTreeMetadata(testData);
      const metadata3 = buildMerkleTreeMetadata(testData);
      
      expect(metadata1.rootHash).toBe(metadata2.rootHash);
      expect(metadata2.rootHash).toBe(metadata3.rootHash);
      expect(metadata1.leafHashes).toEqual(metadata2.leafHashes);
      expect(metadata2.leafHashes).toEqual(metadata3.leafHashes);
    });

    it("should handle data with repeated patterns", () => {
      const repeatedData = new Uint8Array(CHUNK_SIZE * 4);
      // Fill with repeated pattern
      for (let i = 0; i < repeatedData.length; i++) {
        repeatedData[i] = i % 16; // Repeat every 16 bytes
      }
      
      const metadata = buildMerkleTreeMetadata(repeatedData);
      const isValid = verifyMerkleTree(repeatedData, metadata);
      
      expect(isValid).toBe(true);
      expect(metadata.totalChunks).toBe(4);
    });

    it("should handle maximum chunk size data", () => {
      const maxChunkData = new Uint8Array(CHUNK_SIZE);
      for (let i = 0; i < maxChunkData.length; i++) {
        maxChunkData[i] = i % 256;
      }
      
      const metadata = buildMerkleTreeMetadata(maxChunkData);
      
      expect(metadata.totalChunks).toBe(1);
      expect(metadata.treeDepth).toBe(1);
      expect(metadata.rootHash).toBe(metadata.leafHashes[0]);
    });
  });
});