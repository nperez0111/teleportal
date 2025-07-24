import { describe, expect, it } from "bun:test";
import { toBase64 } from "lib0/buffer.js";
import { digest } from "lib0/hash/sha256";
import type { Update } from "teleportal";
import {
  appendFauxUpdateList,
  decodeFauxStateVector,
  decodeFauxUpdateList,
  encodeFauxStateVector,
  encodeFauxUpdateList,
  getEmptyFauxUpdateList,
  type DecodedFauxStateVector,
  type DecodedUpdate,
  type DecodedUpdateList,
} from "./encoding";

function createUpdate(data: Uint8Array): Update {
  return data as Update;
}

describe("e2e encoding", () => {
  describe("State Vector Encoding/Decoding", () => {
    it("should encode and decode a state vector correctly", () => {
      const original: DecodedFauxStateVector = {
        messageId: "test-message-123",
      };

      const encoded = encodeFauxStateVector(original);
      const decoded = decodeFauxStateVector(encoded);

      expect(decoded).toEqual(original);
    });
  });

  describe("Empty Update List", () => {
    it("should create an empty update list", () => {
      const empty = getEmptyFauxUpdateList();
      const decoded = decodeFauxUpdateList(empty);

      expect(decoded).toEqual([]);
      expect(decoded.length).toBe(0);
    });

    it("should decode empty list correctly", () => {
      const empty = getEmptyFauxUpdateList();
      const decoded = decodeFauxUpdateList(empty);

      expect(Array.isArray(decoded)).toBe(true);
      expect(decoded.length).toBe(0);
    });
  });

  describe("Update List Encoding/Decoding", () => {
    it("should encode and decode a single update", () => {
      const original: DecodedUpdateList = [
        {
          messageId: toBase64(digest(new Uint8Array([1, 2, 3, 4, 5]))),
          update: createUpdate(new Uint8Array([1, 2, 3, 4, 5])),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded.length).toBe(1);
    });

    it("should encode and decode multiple updates", () => {
      const original: DecodedUpdateList = [
        {
          messageId: toBase64(digest(new Uint8Array([1, 2, 3]))),
          update: createUpdate(new Uint8Array([1, 2, 3])),
        },
        {
          messageId: toBase64(digest(new Uint8Array([4, 5, 6]))),
          update: createUpdate(new Uint8Array([4, 5, 6])),
        },
        {
          messageId: toBase64(digest(new Uint8Array([7, 8, 9]))),
          update: createUpdate(new Uint8Array([7, 8, 9])),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded.length).toBe(3);
    });

    it("should handle empty updates", () => {
      const original: DecodedUpdateList = [
        {
          messageId: toBase64(digest(new Uint8Array(0))),
          update: createUpdate(new Uint8Array(0)),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded[0].update.length).toBe(0);
    });

    it("should handle large updates", () => {
      const largeUpdate = new Uint8Array(1000);
      for (let i = 0; i < largeUpdate.length; i++) {
        largeUpdate[i] = i % 256;
      }

      const original: DecodedUpdateList = [
        {
          messageId: toBase64(digest(largeUpdate)),
          update: createUpdate(largeUpdate),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded[0].update.length).toBe(1000);
    });

    it("should handle mixed update sizes", () => {
      const original: DecodedUpdateList = [
        {
          messageId: toBase64(digest(new Uint8Array([1]))),
          update: createUpdate(new Uint8Array([1])),
        },
        {
          messageId: toBase64(digest(new Uint8Array([1, 2, 3, 4, 5]))),
          update: createUpdate(new Uint8Array([1, 2, 3, 4, 5])),
        },
        {
          messageId: toBase64(digest(new Uint8Array(100))),
          update: createUpdate(new Uint8Array(100)),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded[0].update.length).toBe(1);
      expect(decoded[1].update.length).toBe(5);
      expect(decoded[2].update.length).toBe(100);
    });
  });

  describe("Append Update List", () => {
    it("should append updates to an empty list", () => {
      const empty = getEmptyFauxUpdateList();
      const newUpdates: DecodedUpdate[] = [
        {
          messageId: toBase64(digest(new Uint8Array([1, 2, 3]))),
          update: createUpdate(new Uint8Array([1, 2, 3])),
        },
        {
          messageId: toBase64(digest(new Uint8Array([4, 5, 6]))),
          update: createUpdate(new Uint8Array([4, 5, 6])),
        },
      ];

      const appended = appendFauxUpdateList(empty, newUpdates);
      const decoded = decodeFauxUpdateList(appended);

      expect(decoded).toEqual(newUpdates);
      expect(decoded.length).toBe(2);
    });

    it("should prepend updates to existing list (newer updates first)", () => {
      const existing: DecodedUpdateList = [
        {
          messageId: toBase64(digest(new Uint8Array([1, 2, 3]))),
          update: createUpdate(new Uint8Array([1, 2, 3])),
        },
        {
          messageId: toBase64(digest(new Uint8Array([4, 5, 6]))),
          update: createUpdate(new Uint8Array([4, 5, 6])),
        },
      ];

      const newUpdates: DecodedUpdate[] = [
        {
          messageId: toBase64(digest(new Uint8Array([7, 8, 9]))),
          update: createUpdate(new Uint8Array([7, 8, 9])),
        },
        {
          messageId: toBase64(digest(new Uint8Array([10, 11, 12]))),
          update: createUpdate(new Uint8Array([10, 11, 12])),
        },
      ];

      const encoded = encodeFauxUpdateList(existing);
      const appended = appendFauxUpdateList(encoded, newUpdates);
      const decoded = decodeFauxUpdateList(appended);

      // New updates are prepended (come first)
      const expected = [...newUpdates, ...existing];
      expect(decoded).toEqual(expected);
      expect(decoded.length).toBe(4);
    });

    it("should handle prepending to single item list", () => {
      const existing: DecodedUpdateList = [
        {
          messageId: toBase64(digest(new Uint8Array([1]))),
          update: createUpdate(new Uint8Array([1])),
        },
      ];

      const newUpdates: DecodedUpdate[] = [
        {
          messageId: toBase64(digest(new Uint8Array([2]))),
          update: createUpdate(new Uint8Array([2])),
        },
      ];

      const encoded = encodeFauxUpdateList(existing);
      const appended = appendFauxUpdateList(encoded, newUpdates);
      const decoded = decodeFauxUpdateList(appended);

      // New updates are prepended
      const expected = [...newUpdates, ...existing];
      expect(decoded).toEqual(expected);
      expect(decoded.length).toBe(2);
    });

    it("should handle appending empty array", () => {
      const existing: DecodedUpdateList = [
        {
          messageId: toBase64(digest(new Uint8Array([1, 2, 3]))),
          update: createUpdate(new Uint8Array([1, 2, 3])),
        },
      ];

      const encoded = encodeFauxUpdateList(existing);
      const appended = appendFauxUpdateList(encoded, []);
      const decoded = decodeFauxUpdateList(appended);

      expect(decoded).toEqual(existing);
      expect(decoded.length).toBe(1);
    });

    it("should handle prepending multiple items", () => {
      const existing: DecodedUpdateList = [
        {
          messageId: toBase64(digest(new Uint8Array([1]))),
          update: createUpdate(new Uint8Array([1])),
        },
      ];

      const newUpdates: DecodedUpdate[] = [
        {
          messageId: toBase64(digest(new Uint8Array([2]))),
          update: createUpdate(new Uint8Array([2])),
        },
        {
          messageId: toBase64(digest(new Uint8Array([3]))),
          update: createUpdate(new Uint8Array([3])),
        },
        {
          messageId: toBase64(digest(new Uint8Array([4]))),
          update: createUpdate(new Uint8Array([4])),
        },
      ];

      const encoded = encodeFauxUpdateList(existing);
      const appended = appendFauxUpdateList(encoded, newUpdates);
      const decoded = decodeFauxUpdateList(appended);

      // New updates are prepended
      const expected = [...newUpdates, ...existing];
      expect(decoded).toEqual(expected);
      expect(decoded.length).toBe(4);
    });
  });

  describe("Round-trip Consistency", () => {
    it("should maintain consistency through multiple encode/decode cycles", () => {
      const original: DecodedUpdateList = [
        {
          messageId: toBase64(digest(new Uint8Array([1, 2, 3, 4, 5]))),
          update: createUpdate(new Uint8Array([1, 2, 3, 4, 5])),
        },
        {
          messageId: toBase64(digest(new Uint8Array([6, 7, 8, 9, 10]))),
          update: createUpdate(new Uint8Array([6, 7, 8, 9, 10])),
        },
      ];

      // Multiple encode/decode cycles
      let current = original;
      for (let i = 0; i < 5; i++) {
        const encoded = encodeFauxUpdateList(current);
        const decoded = decodeFauxUpdateList(encoded);
        expect(decoded).toEqual(original);
        current = decoded;
      }
    });

    it("should maintain consistency for state vectors through multiple cycles", () => {
      const original: DecodedFauxStateVector = {
        messageId: toBase64(digest(new Uint8Array([1, 2, 3, 4, 5]))),
      };

      // Multiple encode/decode cycles
      let current = original;
      for (let i = 0; i < 5; i++) {
        const encoded = encodeFauxStateVector(current);
        const decoded = decodeFauxStateVector(encoded);
        expect(decoded).toEqual(original);
        current = decoded;
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle very large update data", () => {
      const veryLargeUpdate = new Uint8Array(10000);
      for (let i = 0; i < veryLargeUpdate.length; i++) {
        veryLargeUpdate[i] = i % 256;
      }

      const original: DecodedUpdateList = [
        {
          messageId: toBase64(digest(veryLargeUpdate)),
          update: createUpdate(veryLargeUpdate),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded[0].update.length).toBe(10000);
    });

    it("should handle many small updates", () => {
      const manyUpdates: DecodedUpdate[] = [];
      for (let i = 0; i < 100; i++) {
        manyUpdates.push({
          messageId: toBase64(digest(new Uint8Array([i]))),
          update: createUpdate(new Uint8Array([i])),
        });
      }

      const encoded = encodeFauxUpdateList(manyUpdates);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(manyUpdates);
      expect(decoded.length).toBe(100);
    });
  });
});
