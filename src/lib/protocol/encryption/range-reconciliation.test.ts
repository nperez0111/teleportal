import { describe, expect, it } from "bun:test";
import type { SeenMessageMapping } from "./sync";
import {
  computeSetDifference,
  computeSetDifferenceFromStateVector,
  fromRangeBased,
  mergeRangeBased,
  toRangeBased,
} from "./range-reconciliation";

describe("range-reconciliation", () => {
  describe("toRangeBased", () => {
    it("should convert empty seen messages to empty range-based format", () => {
      const seenMessages: SeenMessageMapping = {};
      const result = toRangeBased(seenMessages);

      expect(Object.keys(result).length).toBe(0);
    });

    it("should convert single message to single range", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1" },
      };
      const result = toRangeBased(seenMessages);

      expect(result[1].ranges).toEqual([{ start: 5, end: 5 }]);
      expect(result[1].messageIds.get(5)).toBe("msg1");
    });

    it("should convert consecutive messages to single range", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 3: "msg3", 4: "msg4", 5: "msg5" },
      };
      const result = toRangeBased(seenMessages);

      expect(result[1].ranges).toEqual([{ start: 1, end: 5 }]);
      expect(result[1].messageIds.size).toBe(5);
    });

    it("should convert non-consecutive messages to multiple ranges", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 3: "msg3", 5: "msg5", 7: "msg7" },
      };
      const result = toRangeBased(seenMessages);

      expect(result[1].ranges).toEqual([
        { start: 1, end: 1 },
        { start: 3, end: 3 },
        { start: 5, end: 5 },
        { start: 7, end: 7 },
      ]);
    });

    it("should convert mixed consecutive and non-consecutive messages", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 5: "msg5", 6: "msg6", 7: "msg7", 10: "msg10" },
      };
      const result = toRangeBased(seenMessages);

      expect(result[1].ranges).toEqual([
        { start: 1, end: 2 },
        { start: 5, end: 7 },
        { start: 10, end: 10 },
      ]);
    });

    it("should handle multiple clients", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2" },
        2: { 3: "msg3", 4: "msg4", 5: "msg5" },
      };
      const result = toRangeBased(seenMessages);

      expect(result[1].ranges).toEqual([{ start: 1, end: 2 }]);
      expect(result[2].ranges).toEqual([{ start: 3, end: 5 }]);
    });
  });

  describe("fromRangeBased", () => {
    it("should convert empty range-based format to empty seen messages", () => {
      const rangeBased = {};
      const result = fromRangeBased(rangeBased);

      expect(Object.keys(result).length).toBe(0);
    });

    it("should convert single range back to seen messages", () => {
      const rangeBased = {
        1: {
          ranges: [{ start: 5, end: 5 }],
          messageIds: new Map([[5, "msg1"]]),
        },
      };
      const result = fromRangeBased(rangeBased);

      expect(result[1][5]).toBe("msg1");
    });

    it("should convert consecutive range back to seen messages", () => {
      const rangeBased = {
        1: {
          ranges: [{ start: 1, end: 5 }],
          messageIds: new Map([
            [1, "msg1"],
            [2, "msg2"],
            [3, "msg3"],
            [4, "msg4"],
            [5, "msg5"],
          ]),
        },
      };
      const result = fromRangeBased(rangeBased);

      expect(result[1][1]).toBe("msg1");
      expect(result[1][2]).toBe("msg2");
      expect(result[1][3]).toBe("msg3");
      expect(result[1][4]).toBe("msg4");
      expect(result[1][5]).toBe("msg5");
    });

    it("should round-trip conversion", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 5: "msg5", 6: "msg6", 7: "msg7" },
        2: { 3: "msg3", 4: "msg4" },
      };
      const rangeBased = toRangeBased(seenMessages);
      const result = fromRangeBased(rangeBased);

      expect(result).toEqual(seenMessages);
    });
  });

  describe("computeSetDifferenceFromStateVector", () => {
    it("should return all messages when remote state vector is empty", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 3: "msg3" },
      };
      const rangeBased = toRangeBased(seenMessages);
      const remoteStateVector = new Map<number, number>();

      const difference = computeSetDifferenceFromStateVector(
        rangeBased,
        remoteStateVector,
      );

      expect(difference.get(1)?.size).toBe(3);
      expect(difference.get(1)?.get(1)).toBe("msg1");
      expect(difference.get(1)?.get(2)).toBe("msg2");
      expect(difference.get(1)?.get(3)).toBe("msg3");
    });

    it("should return only messages after remote's max counter", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 3: "msg3", 4: "msg4", 5: "msg5" },
      };
      const rangeBased = toRangeBased(seenMessages);
      const remoteStateVector = new Map([[1, 2]]); // Remote has seen up to counter 2

      const difference = computeSetDifferenceFromStateVector(
        rangeBased,
        remoteStateVector,
      );

      expect(difference.get(1)?.size).toBe(3);
      expect(difference.get(1)?.get(3)).toBe("msg3");
      expect(difference.get(1)?.get(4)).toBe("msg4");
      expect(difference.get(1)?.get(5)).toBe("msg5");
      expect(difference.get(1)?.has(1)).toBe(false);
      expect(difference.get(1)?.has(2)).toBe(false);
    });

    it("should return empty when local has no new messages", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2" },
      };
      const rangeBased = toRangeBased(seenMessages);
      const remoteStateVector = new Map([[1, 5]]); // Remote has seen more

      const difference = computeSetDifferenceFromStateVector(
        rangeBased,
        remoteStateVector,
      );

      expect(difference.size).toBe(0);
    });

    it("should handle non-consecutive ranges correctly", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 5: "msg5", 6: "msg6", 10: "msg10" },
      };
      const rangeBased = toRangeBased(seenMessages);
      const remoteStateVector = new Map([[1, 3]]); // Remote has seen up to counter 3

      const difference = computeSetDifferenceFromStateVector(
        rangeBased,
        remoteStateVector,
      );

      expect(difference.get(1)?.size).toBe(3);
      expect(difference.get(1)?.get(5)).toBe("msg5");
      expect(difference.get(1)?.get(6)).toBe("msg6");
      expect(difference.get(1)?.get(10)).toBe("msg10");
    });

    it("should handle multiple clients", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 3: "msg3" },
        2: { 5: "msg5", 6: "msg6" },
      };
      const rangeBased = toRangeBased(seenMessages);
      const remoteStateVector = new Map([
        [1, 1], // Remote has seen up to counter 1 for client 1
        [2, 4], // Remote has seen up to counter 4 for client 2
      ]);

      const difference = computeSetDifferenceFromStateVector(
        rangeBased,
        remoteStateVector,
      );

      expect(difference.get(1)?.size).toBe(2);
      expect(difference.get(1)?.get(2)).toBe("msg2");
      expect(difference.get(1)?.get(3)).toBe("msg3");
      expect(difference.get(2)?.size).toBe(2);
      expect(difference.get(2)?.get(5)).toBe("msg5");
      expect(difference.get(2)?.get(6)).toBe("msg6");
    });
  });

  describe("computeSetDifference", () => {
    it("should return all local messages when remote is empty", () => {
      const local: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2" },
      };
      const remote: SeenMessageMapping = {};
      const localRange = toRangeBased(local);
      const remoteRange = toRangeBased(remote);

      const difference = computeSetDifference(localRange, remoteRange);

      expect(difference.get(1)?.size).toBe(2);
    });

    it("should return only messages not in remote", () => {
      const local: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 3: "msg3", 4: "msg4" },
      };
      const remote: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2" },
      };
      const localRange = toRangeBased(local);
      const remoteRange = toRangeBased(remote);

      const difference = computeSetDifference(localRange, remoteRange);

      expect(difference.get(1)?.size).toBe(2);
      expect(difference.get(1)?.get(3)).toBe("msg3");
      expect(difference.get(1)?.get(4)).toBe("msg4");
    });

    it("should return empty when all messages are in remote", () => {
      const local: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2" },
      };
      const remote: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 3: "msg3" },
      };
      const localRange = toRangeBased(local);
      const remoteRange = toRangeBased(remote);

      const difference = computeSetDifference(localRange, remoteRange);

      expect(difference.size).toBe(0);
    });
  });

  describe("mergeRangeBased", () => {
    it("should merge new messages into empty local", () => {
      const local = {};
      const incoming = new Map([
        [1, new Map([[1, "msg1"], [2, "msg2"]])],
      ]);

      const result = mergeRangeBased(local, incoming);

      expect(result[1].ranges).toEqual([{ start: 1, end: 2 }]);
      expect(result[1].messageIds.get(1)).toBe("msg1");
      expect(result[1].messageIds.get(2)).toBe("msg2");
    });

    it("should merge new messages into existing local", () => {
      const local: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2" },
      };
      const localRange = toRangeBased(local);
      const incoming = new Map([
        [1, new Map([[3, "msg3"], [4, "msg4"]])],
      ]);

      const result = mergeRangeBased(localRange, incoming);

      expect(result[1].ranges.length).toBeGreaterThan(0);
      expect(result[1].messageIds.get(1)).toBe("msg1");
      expect(result[1].messageIds.get(2)).toBe("msg2");
      expect(result[1].messageIds.get(3)).toBe("msg3");
      expect(result[1].messageIds.get(4)).toBe("msg4");
    });

    it("should handle non-consecutive merges", () => {
      const local: SeenMessageMapping = {
        1: { 1: "msg1", 5: "msg5" },
      };
      const localRange = toRangeBased(local);
      const incoming = new Map([
        [1, new Map([[3, "msg3"], [7, "msg7"]])],
      ]);

      const result = mergeRangeBased(localRange, incoming);

      expect(result[1].messageIds.get(1)).toBe("msg1");
      expect(result[1].messageIds.get(3)).toBe("msg3");
      expect(result[1].messageIds.get(5)).toBe("msg5");
      expect(result[1].messageIds.get(7)).toBe("msg7");
    });
  });
});
