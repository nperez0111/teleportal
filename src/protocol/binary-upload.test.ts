import { describe, expect, it } from "bun:test";
import { decodeMessage, encodeMessage } from "./index";
import { BlobMessage } from "./message-types";
import type {
  DecodedBlobPartMessage,
  DecodedRequestBlobMessage,
} from "./types";
import {
  createRequestBlob,
  generateContentId,
  generateRequestId,
  getFileMetadata,
  MAX_SEGMENT_SIZE,
  reconstructFileFromSegments,
  segmentFileForUpload,
  verifyContentIntegrity,
} from "./utils";

describe("Blob Message", () => {
  describe("Blob Part", () => {
    it("should encode and decode a blob part message", () => {
      const fileData = new Uint8Array([1, 2, 3, 4, 5]);
      const contentId = generateContentId(fileData);

      const payload: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 1,
        contentId,
        name: "test.txt",
        contentType: "text/plain",
        data: fileData,
      };

      const message = new BlobMessage("test-doc", payload);
      const encoded = encodeMessage(message);
      const decoded = decodeMessage(encoded);

      expect(decoded.type).toBe("blob");
      expect(decoded.document).toBe("test-doc");

      if (decoded.type === "blob" && decoded.payload.type === "blob-part") {
        expect(decoded.payload.segmentIndex).toBe(0);
        expect(decoded.payload.totalSegments).toBe(1);
        expect(decoded.payload.contentId).toBe(contentId);
        expect(decoded.payload.name).toBe("test.txt");
        expect(decoded.payload.contentType).toBe("text/plain");
        expect(decoded.payload.data).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
      } else {
        throw new Error("Expected blob part message");
      }
    });

    it("should handle blob part message without document ID", () => {
      const fileData = new Uint8Array([255, 216, 255, 224]); // JPEG header
      const contentId = generateContentId(fileData);

      const payload: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 1,
        contentId,
        name: "image.jpg",
        contentType: "image/jpeg",
        data: fileData,
      };

      const message = new BlobMessage("test-doc", payload);
      const encoded = encodeMessage(message);
      const decoded = decodeMessage(encoded);

      if (decoded.type === "blob" && decoded.payload.type === "blob-part") {
        expect(decoded.payload.contentType).toBe("image/jpeg");
        expect(decoded.payload.contentId).toBe(contentId);
      } else {
        throw new Error("Expected blob part message");
      }
    });

    it("should handle empty files", () => {
      const emptyData = new Uint8Array(0);
      const contentId = generateContentId(emptyData);

      const payload: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 1,
        contentId,
        name: "empty.txt",
        contentType: "text/plain",
        data: emptyData,
      };

      const message = new BlobMessage("test-doc", payload);
      const encoded = encodeMessage(message);
      const decoded = decodeMessage(encoded);

      if (decoded.type === "blob" && decoded.payload.type === "blob-part") {
        expect(decoded.payload.data.length).toBe(0);
        expect(decoded.payload.contentId).toBe(contentId);
      } else {
        throw new Error("Expected blob part message");
      }
    });

    it("should handle very large files with multiple segments", () => {
      // Create a file that's exactly 3 segments (12MB)
      const largeFileData = new Uint8Array(MAX_SEGMENT_SIZE * 3);
      for (let i = 0; i < largeFileData.length; i++) {
        largeFileData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        largeFileData,
        "very-large.bin",
        "application/octet-stream",
      );

      expect(segments.length).toBe(3);

      if (
        segments[0].payload.type === "blob-part" &&
        segments[1].payload.type === "blob-part" &&
        segments[2].payload.type === "blob-part"
      ) {
        expect(segments[0].payload.segmentIndex).toBe(0);
        expect(segments[1].payload.segmentIndex).toBe(1);
        expect(segments[2].payload.segmentIndex).toBe(2);

        expect(segments[0].payload.totalSegments).toBe(3);
        expect(segments[1].payload.totalSegments).toBe(3);
        expect(segments[2].payload.totalSegments).toBe(3);

        expect(segments[0].payload.data.length).toBe(MAX_SEGMENT_SIZE);
        expect(segments[1].payload.data.length).toBe(MAX_SEGMENT_SIZE);
        expect(segments[2].payload.data.length).toBe(MAX_SEGMENT_SIZE);

        // All segments should have the same content ID
        const contentId = segments[0].payload.contentId;
        expect(segments[1].payload.contentId).toBe(contentId);
        expect(segments[2].payload.contentId).toBe(contentId);
      } else {
        throw new Error("Expected blob part messages");
      }
    });

    it("should handle files exactly at segment boundary", () => {
      // Create a file that's exactly 4MB (one segment)
      const exactSegmentData = new Uint8Array(MAX_SEGMENT_SIZE);
      for (let i = 0; i < exactSegmentData.length; i++) {
        exactSegmentData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        exactSegmentData,
        "exact-segment.bin",
        "application/octet-stream",
      );

      expect(segments.length).toBe(1);

      if (segments[0].payload.type === "blob-part") {
        expect(segments[0].payload.segmentIndex).toBe(0);
        expect(segments[0].payload.totalSegments).toBe(1);
        expect(segments[0].payload.data.length).toBe(MAX_SEGMENT_SIZE);
      } else {
        throw new Error("Expected blob part message");
      }
    });

    it("should handle files just under segment boundary", () => {
      // Create a file that's just under 4MB
      const underSegmentData = new Uint8Array(MAX_SEGMENT_SIZE - 1);
      for (let i = 0; i < underSegmentData.length; i++) {
        underSegmentData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        underSegmentData,
        "under-segment.bin",
        "application/octet-stream",
      );

      expect(segments.length).toBe(1);

      if (segments[0].payload.type === "blob-part") {
        expect(segments[0].payload.segmentIndex).toBe(0);
        expect(segments[0].payload.totalSegments).toBe(1);
        expect(segments[0].payload.data.length).toBe(MAX_SEGMENT_SIZE - 1);
      } else {
        throw new Error("Expected blob part message");
      }
    });

    it("should handle files just over segment boundary", () => {
      // Create a file that's just over 4MB
      const overSegmentData = new Uint8Array(MAX_SEGMENT_SIZE + 1);
      for (let i = 0; i < overSegmentData.length; i++) {
        overSegmentData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        overSegmentData,
        "over-segment.bin",
        "application/octet-stream",
      );

      expect(segments.length).toBe(2);

      if (
        segments[0].payload.type === "blob-part" &&
        segments[1].payload.type === "blob-part"
      ) {
        expect(segments[0].payload.segmentIndex).toBe(0);
        expect(segments[1].payload.segmentIndex).toBe(1);
        expect(segments[0].payload.totalSegments).toBe(2);
        expect(segments[1].payload.totalSegments).toBe(2);
        expect(segments[0].payload.data.length).toBe(MAX_SEGMENT_SIZE);
        expect(segments[1].payload.data.length).toBe(1);
      } else {
        throw new Error("Expected blob part messages");
      }
    });

    it("should verify content integrity across segments", () => {
      const originalData = new Uint8Array(MAX_SEGMENT_SIZE + 1024);
      for (let i = 0; i < originalData.length; i++) {
        originalData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        originalData,
        "integrity-test.bin",
        "application/octet-stream",
      );

      // Reconstruct the file
      const reconstructed = new Uint8Array(originalData.length);
      let offset = 0;

      for (const segment of segments) {
        if (segment.payload.type === "blob-part") {
          reconstructed.set(segment.payload.data, offset);
          offset += segment.payload.data.length;
        }
      }

      // Verify the reconstructed data matches original
      expect(reconstructed).toEqual(originalData);

      // Verify content ID matches
      const originalContentId = generateContentId(originalData);
      const reconstructedContentId = generateContentId(reconstructed);
      expect(reconstructedContentId).toBe(originalContentId);
    });

    it("should handle various content types", () => {
      const testCases = [
        {
          name: "text.txt",
          contentType: "text/plain",
          data: new TextEncoder().encode("Hello World"),
        },
        {
          name: "image.png",
          contentType: "image/png",
          data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        }, // PNG header
        {
          name: "data.json",
          contentType: "application/json",
          data: new TextEncoder().encode('{"key": "value"}'),
        },
        {
          name: "archive.zip",
          contentType: "application/zip",
          data: new Uint8Array([80, 75, 3, 4]),
        }, // ZIP header
        {
          name: "video.mp4",
          contentType: "video/mp4",
          data: new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112]),
        }, // MP4 header
      ];

      for (const testCase of testCases) {
        const contentId = generateContentId(testCase.data);

        const payload: DecodedBlobPartMessage = {
          type: "blob-part",
          segmentIndex: 0,
          totalSegments: 1,
          contentId,
          name: testCase.name,
          contentType: testCase.contentType,
          data: testCase.data,
        };

        const message = new BlobMessage("test-doc", payload);
        const encoded = encodeMessage(message);
        const decoded = decodeMessage(encoded);

        if (decoded.type === "blob" && decoded.payload.type === "blob-part") {
          expect(decoded.payload.name).toBe(testCase.name);
          expect(decoded.payload.contentType).toBe(testCase.contentType);
          expect(decoded.payload.data).toEqual(testCase.data);
          expect(decoded.payload.contentId).toBe(contentId);
        } else {
          throw new Error("Expected blob part message");
        }
      }
    });

    it("should handle special characters in file names", () => {
      const specialNames = [
        "file with spaces.txt",
        "file-with-dashes.txt",
        "file_with_underscores.txt",
        "file.with.dots.txt",
        "file@#$%^&*().txt",
        "file-中文-日本語-한국어.txt",
        "file-émojis-🚀-🎉.txt",
      ];

      const fileData = new Uint8Array([1, 2, 3, 4, 5]);
      const contentId = generateContentId(fileData);

      for (const name of specialNames) {
        const payload: DecodedBlobPartMessage = {
          type: "blob-part",
          segmentIndex: 0,
          totalSegments: 1,
          contentId,
          name,
          contentType: "text/plain",
          data: fileData,
        };

        const message = new BlobMessage("test-doc", payload);
        const encoded = encodeMessage(message);
        const decoded = decodeMessage(encoded);

        if (decoded.type === "blob" && decoded.payload.type === "blob-part") {
          expect(decoded.payload.name).toBe(name);
        } else {
          throw new Error("Expected blob part message");
        }
      }
    });

    it("should handle long file names", () => {
      const longName = "a".repeat(1000) + ".txt";
      const fileData = new Uint8Array([1, 2, 3, 4, 5]);
      const contentId = generateContentId(fileData);

      const payload: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 1,
        contentId,
        name: longName,
        contentType: "text/plain",
        data: fileData,
      };

      const message = new BlobMessage("test-doc", payload);
      const encoded = encodeMessage(message);
      const decoded = decodeMessage(encoded);

      if (decoded.type === "blob" && decoded.payload.type === "blob-part") {
        expect(decoded.payload.name).toBe(longName);
        expect(decoded.payload.name.length).toBe(1004);
      } else {
        throw new Error("Expected blob part message");
      }
    });

    it("should handle empty file names", () => {
      const fileData = new Uint8Array([1, 2, 3, 4, 5]);
      const contentId = generateContentId(fileData);

      const payload: DecodedBlobPartMessage = {
        type: "blob-part",
        segmentIndex: 0,
        totalSegments: 1,
        contentId,
        name: "",
        contentType: "text/plain",
        data: fileData,
      };

      const message = new BlobMessage("test-doc", payload);
      const encoded = encodeMessage(message);
      const decoded = decodeMessage(encoded);

      if (decoded.type === "blob" && decoded.payload.type === "blob-part") {
        expect(decoded.payload.name).toBe("");
      } else {
        throw new Error("Expected blob part message");
      }
    });

    it("should segment large files correctly", () => {
      // Create a file larger than 4MB
      const largeFileData = new Uint8Array(MAX_SEGMENT_SIZE + 1024);
      for (let i = 0; i < largeFileData.length; i++) {
        largeFileData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        largeFileData,
        "large-file.bin",
        "application/octet-stream",
      );

      expect(segments.length).toBe(2);

      if (
        segments[0].payload.type === "blob-part" &&
        segments[1].payload.type === "blob-part"
      ) {
        expect(segments[0].payload.segmentIndex).toBe(0);
        expect(segments[0].payload.totalSegments).toBe(2);
        expect(segments[1].payload.segmentIndex).toBe(1);
        expect(segments[1].payload.totalSegments).toBe(2);
        expect(segments[0].payload.name).toBe("large-file.bin");
        expect(segments[1].payload.name).toBe("large-file.bin");
        expect(segments[0].payload.data.length).toBe(MAX_SEGMENT_SIZE);
        expect(segments[1].payload.data.length).toBe(1024);

        // Verify the data can be reconstructed
        const reconstructed = new Uint8Array(MAX_SEGMENT_SIZE + 1024);
        reconstructed.set(segments[0].payload.data, 0);
        reconstructed.set(segments[1].payload.data, MAX_SEGMENT_SIZE);
        expect(reconstructed).toEqual(largeFileData);
      } else {
        throw new Error("Expected blob part messages");
      }
    });

    it("should handle small files that don't need segmentation", () => {
      const smallFileData = new Uint8Array(1024);
      for (let i = 0; i < smallFileData.length; i++) {
        smallFileData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        smallFileData,
        "small-file.txt",
        "text/plain",
      );

      expect(segments.length).toBe(1);

      if (segments[0].payload.type === "blob-part") {
        expect(segments[0].payload.segmentIndex).toBe(0);
        expect(segments[0].payload.totalSegments).toBe(1);
        expect(segments[0].payload.data).toEqual(smallFileData);
      } else {
        throw new Error("Expected blob part message");
      }
    });

    it("should encode and decode segmented messages", () => {
      const fileData = new Uint8Array(MAX_SEGMENT_SIZE + 512);
      for (let i = 0; i < fileData.length; i++) {
        fileData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        fileData,
        "test-segmented.bin",
        "application/octet-stream",
      );

      // Encode and decode each segment
      for (const segment of segments) {
        const encoded = encodeMessage(segment);
        const decoded = decodeMessage(encoded);

        expect(decoded.type).toBe("blob");

        if (decoded.payload.type === "blob-part") {
          expect(decoded.payload.name).toBe("test-segmented.bin");
          expect(decoded.payload.contentType).toBe("application/octet-stream");
        } else {
          throw new Error("Expected blob part payload");
        }
      }
    });

    it("should reconstruct files using utility function", () => {
      const originalData = new Uint8Array(MAX_SEGMENT_SIZE + 2048);
      for (let i = 0; i < originalData.length; i++) {
        originalData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        originalData,
        "reconstruction-test.bin",
        "application/octet-stream",
      );

      const reconstructed = reconstructFileFromSegments(segments);
      expect(reconstructed).not.toBeNull();
      expect(reconstructed).toEqual(originalData);
    });

    it("should verify content integrity using utility function", () => {
      const fileData = new Uint8Array(MAX_SEGMENT_SIZE + 1024);
      for (let i = 0; i < fileData.length; i++) {
        fileData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        fileData,
        "integrity-test.bin",
        "application/octet-stream",
      );

      const isIntegrityValid = verifyContentIntegrity(segments);
      expect(isIntegrityValid).toBe(true);
    });

    it("should detect content integrity violations", () => {
      const fileData = new Uint8Array(MAX_SEGMENT_SIZE + 1024);
      for (let i = 0; i < fileData.length; i++) {
        fileData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        fileData,
        "integrity-test.bin",
        "application/octet-stream",
      );

      // Modify one segment to simulate corruption
      if (segments[0].payload.type === "blob-part") {
        segments[0].payload.contentId = "corrupted-content-id";
      }

      const isIntegrityValid = verifyContentIntegrity(segments);
      expect(isIntegrityValid).toBe(false);
    });

    it("should extract file metadata using utility function", () => {
      const fileData = new Uint8Array(1024);
      for (let i = 0; i < fileData.length; i++) {
        fileData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        fileData,
        "metadata-test.txt",
        "text/plain",
      );

      const metadata = getFileMetadata(segments);
      expect(metadata).not.toBeNull();

      if (metadata) {
        expect(metadata.name).toBe("metadata-test.txt");
        expect(metadata.contentType).toBe("text/plain");
        expect(metadata.totalSegments).toBe(1);
        expect(metadata.totalSize).toBe(1024);
        expect(metadata.contentId).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      }
    });

    it("should handle out-of-order segments during reconstruction", () => {
      const originalData = new Uint8Array(MAX_SEGMENT_SIZE + 2048);
      for (let i = 0; i < originalData.length; i++) {
        originalData[i] = i % 256;
      }

      const segments = segmentFileForUpload(
        originalData,
        "order-test.bin",
        "application/octet-stream",
      );

      // Shuffle the segments to simulate out-of-order arrival
      const shuffledSegments = [...segments].sort(() => Math.random() - 0.5);

      const reconstructed = reconstructFileFromSegments(shuffledSegments);
      expect(reconstructed).not.toBeNull();
      expect(reconstructed).toEqual(originalData);
    });

    it("should handle empty segment arrays", () => {
      const emptySegments: BlobMessage<Record<string, unknown>>[] = [];

      const reconstructed = reconstructFileFromSegments(emptySegments);
      expect(reconstructed).toBeNull();

      const isIntegrityValid = verifyContentIntegrity(emptySegments);
      expect(isIntegrityValid).toBe(false);

      const metadata = getFileMetadata(emptySegments);
      expect(metadata).toBeNull();
    });
  });

  describe("Request Blob", () => {
    it("should encode and decode a request blob message", () => {
      const contentId = "test-content-id-123";
      const requestId = generateRequestId();

      const payload: DecodedRequestBlobMessage = {
        type: "request-blob",
        requestId,
        contentId,
        name: "requested-file.txt",
      };

      const message = new BlobMessage("test-doc", payload);
      const encoded = encodeMessage(message);
      const decoded = decodeMessage(encoded);

      expect(decoded.type).toBe("blob");
      expect(decoded.document).toBe("test-doc");

      if (decoded.type === "blob" && decoded.payload.type === "request-blob") {
        expect(decoded.payload.requestId).toBe(requestId);
        expect(decoded.payload.contentId).toBe(contentId);
        expect(decoded.payload.name).toBe("requested-file.txt");
      } else {
        throw new Error("Expected request blob message");
      }
    });

    it("should handle request blob without name", () => {
      const contentId = "test-content-id-456";
      const requestId = generateRequestId();

      const payload: DecodedRequestBlobMessage = {
        type: "request-blob",
        requestId,
        contentId,
      };

      const message = new BlobMessage("test-doc", payload);
      const encoded = encodeMessage(message);
      const decoded = decodeMessage(encoded);

      if (decoded.type === "blob" && decoded.payload.type === "request-blob") {
        expect(decoded.payload.requestId).toBe(requestId);
        expect(decoded.payload.contentId).toBe(contentId);
        expect(decoded.payload.name).toBeUndefined();
      } else {
        throw new Error("Expected request blob message");
      }
    });

    it("should generate unique request IDs", () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^req_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^req_\d+_[a-z0-9]+$/);
    });

    it("should create request blob using utility function", () => {
      const contentId = "test-content-id-789";
      const name = "utility-test.txt";

      const message = createRequestBlob(contentId, name);

      expect(message.type).toBe("blob");
      expect(message.payload.type).toBe("request-blob");

      if (message.payload.type === "request-blob") {
        expect(message.payload.contentId).toBe(contentId);
        expect(message.payload.name).toBe(name);
        expect(message.payload.requestId).toMatch(/^req_\d+_[a-z0-9]+$/);
      } else {
        throw new Error("Expected request blob payload");
      }
    });

    it("should create request blob without name using utility function", () => {
      const contentId = "test-content-id-999";

      const message = createRequestBlob(contentId);

      expect(message.type).toBe("blob");
      expect(message.payload.type).toBe("request-blob");

      if (message.payload.type === "request-blob") {
        expect(message.payload.contentId).toBe(contentId);
        expect(message.payload.name).toBeUndefined();
        expect(message.payload.requestId).toMatch(/^req_\d+_[a-z0-9]+$/);
      } else {
        throw new Error("Expected request blob payload");
      }
    });
  });

  describe("Content ID Generation", () => {
    it("should generate consistent content-based IDs", () => {
      const fileData = new Uint8Array([1, 2, 3, 4, 5]);
      const id1 = generateContentId(fileData);
      const id2 = generateContentId(fileData);

      expect(id1).toBe(id2);
      expect(id1).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); // Base64 pattern
    });

    it("should generate different IDs for different content", () => {
      const fileData1 = new Uint8Array([1, 2, 3, 4, 5]);
      const fileData2 = new Uint8Array([1, 2, 3, 4, 6]);

      const id1 = generateContentId(fileData1);
      const id2 = generateContentId(fileData2);

      expect(id1).not.toBe(id2);
    });
  });
});
