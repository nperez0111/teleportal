import { beforeEach, describe, expect, it } from "bun:test";
import type { ClientId, LamportClockValue } from "./lamport-clock";
import { LamportClock } from "./lamport-clock";

describe("lamport clock", () => {
  let clock: LamportClock;

  beforeEach(() => {
    clock = new LamportClock(1);
  });

  describe("LamportClock class", () => {
    it("should initialize with client id and counter", () => {
      expect(clock.getTimestamp()).toEqual([1, 0]);
    });

    it("should initialize with custom counter", () => {
      const clockWithCounter = new LamportClock(2, 5);
      expect(clockWithCounter.getTimestamp()).toEqual([2, 5]);
    });

    it("should tick and increment counter", () => {
      const timestamp1 = clock.tick();
      expect(timestamp1).toEqual([1, 1]);
      expect(clock.getTimestamp()).toEqual([1, 1]);

      const timestamp2 = clock.tick();
      expect(timestamp2).toEqual([1, 2]);
      expect(clock.getTimestamp()).toEqual([1, 2]);
    });

    it("should send event (same as tick)", () => {
      const timestamp = clock.send();
      expect(timestamp).toEqual([1, 1]);
      expect(clock.getTimestamp()).toEqual([1, 1]);
    });

    it("should receive event and update counter to max + 1", () => {
      // First tick to have some local events
      clock.tick();
      clock.tick();
      expect(clock.getTimestamp()).toEqual([1, 2]);

      // Receive event from another client with higher counter
      const receivedTimestamp: LamportClockValue = [2, 5];
      const newTimestamp = clock.receive(receivedTimestamp);
      expect(newTimestamp).toEqual([1, 6]); // max(2, 5) + 1
      expect(clock.getTimestamp()).toEqual([1, 6]);
    });

    it("should handle receive with lower counter", () => {
      // First tick to have some local events
      clock.tick();
      clock.tick();
      expect(clock.getTimestamp()).toEqual([1, 2]);

      // Receive event with lower counter
      const receivedTimestamp: LamportClockValue = [2, 1];
      const newTimestamp = clock.receive(receivedTimestamp);
      expect(newTimestamp).toEqual([1, 3]); // max(2, 1) + 1
      expect(clock.getTimestamp()).toEqual([1, 3]);
    });

    it("should handle receive with equal counter", () => {
      // First tick to have some local events
      clock.tick();
      clock.tick();
      expect(clock.getTimestamp()).toEqual([1, 2]);

      // Receive event with equal counter
      const receivedTimestamp: LamportClockValue = [2, 2];
      const newTimestamp = clock.receive(receivedTimestamp);
      expect(newTimestamp).toEqual([1, 3]); // max(2, 2) + 1
      expect(clock.getTimestamp()).toEqual([1, 3]);
    });

    it("should handle receive from same client", () => {
      // First tick to have some local events
      clock.tick();
      clock.tick();
      expect(clock.getTimestamp()).toEqual([1, 2]);

      // Receive event from same client with higher counter
      const receivedTimestamp: LamportClockValue = [1, 5];
      const newTimestamp = clock.receive(receivedTimestamp);
      expect(newTimestamp).toEqual([1, 6]); // max(2, 5) + 1
      expect(clock.getTimestamp()).toEqual([1, 6]);
    });

    it("should maintain client id through all operations", () => {
      const clientId: ClientId = 42;
      const clockWithCustomId = new LamportClock(clientId, 10);

      expect(clockWithCustomId.getTimestamp()[0]).toBe(clientId);

      const tickResult = clockWithCustomId.tick();
      expect(tickResult[0]).toBe(clientId);

      const sendResult = clockWithCustomId.send();
      expect(sendResult[0]).toBe(clientId);

      const receiveResult = clockWithCustomId.receive([99, 20]);
      expect(receiveResult[0]).toBe(clientId);
    });
  });

  describe("LamportClock static methods", () => {
    it("should convert client id and counter to lamport clock id", () => {
      const id = LamportClock.toLamportClockId(1, 5);
      expect(id).toBe("1-5");
    });

    it("should convert large numbers to lamport clock id", () => {
      const id = LamportClock.toLamportClockId(999999, 123456);
      expect(id).toBe("999999-123456");
    });

    it("should convert zero values to lamport clock id", () => {
      const id = LamportClock.toLamportClockId(0, 0);
      expect(id).toBe("0-0");
    });

    it("should convert lamport clock id to client id and counter", () => {
      const [clientId, counter] = LamportClock.fromLamportClockId("1-5");
      expect(clientId).toBe(1);
      expect(counter).toBe(5);
    });

    it("should convert large lamport clock id to client id and counter", () => {
      const [clientId, counter] =
        LamportClock.fromLamportClockId("999999-123456");
      expect(clientId).toBe(999999);
      expect(counter).toBe(123456);
    });

    it("should convert zero lamport clock id to client id and counter", () => {
      const [clientId, counter] = LamportClock.fromLamportClockId("0-0");
      expect(clientId).toBe(0);
      expect(counter).toBe(0);
    });

    it("should handle lamport clock id with single digit values", () => {
      const [clientId, counter] = LamportClock.fromLamportClockId("3-7");
      expect(clientId).toBe(3);
      expect(counter).toBe(7);
    });
  });

  describe("LamportClock edge cases", () => {
    it("should handle multiple consecutive ticks", () => {
      for (let i = 1; i <= 10; i++) {
        const timestamp = clock.tick();
        expect(timestamp).toEqual([1, i]);
        expect(clock.getTimestamp()).toEqual([1, i]);
      }
    });

    it("should handle multiple consecutive receives", () => {
      clock.tick(); // Start at [1, 1]

      // Receive multiple events
      const receive1 = clock.receive([2, 3]);
      expect(receive1).toEqual([1, 4]);

      const receive2 = clock.receive([3, 6]);
      expect(receive2).toEqual([1, 7]);

      const receive3 = clock.receive([2, 2]);
      expect(receive3).toEqual([1, 8]);
    });

    it("should handle mixed operations", () => {
      // Initial state
      expect(clock.getTimestamp()).toEqual([1, 0]);

      // Tick
      expect(clock.tick()).toEqual([1, 1]);

      // Receive
      expect(clock.receive([2, 5])).toEqual([1, 6]);

      // Send
      expect(clock.send()).toEqual([1, 7]);

      // Receive again
      expect(clock.receive([3, 3])).toEqual([1, 8]);

      // Final state
      expect(clock.getTimestamp()).toEqual([1, 8]);
    });
  });
});
