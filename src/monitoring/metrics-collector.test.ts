import { describe, expect, test, mock } from "bun:test";
import { MetricsCollector } from "./metrics-collector";

// Mock the Registry to avoid global state issues
class MockRegistry {
  private metrics: any[] = [];
  register(metric: any) {
    this.metrics.push(metric);
  }
  format() {
    return this.metrics.map((m) => m.toString()).join("\n") + "\n";
  }
}

describe("MetricsCollector Message Tracking", () => {
  test("incrementMessage tracks per-type and total counts", () => {
    const registry = new MockRegistry() as any;
    const collector = new MetricsCollector(registry);

    // Initially empty
    expect(collector.getMessageCountsByType()).toEqual({});

    // Increment awareness messages
    collector.incrementMessage("awareness");
    collector.incrementMessage("awareness");
    expect(collector.getMessageCountsByType()).toEqual({ awareness: 2 });

    // Increment doc messages
    collector.incrementMessage("doc");
    collector.incrementMessage("doc");
    collector.incrementMessage("doc");
    expect(collector.getMessageCountsByType()).toEqual({
      awareness: 2,
      doc: 3,
    });

    // Increment file messages
    collector.incrementMessage("file");
    expect(collector.getMessageCountsByType()).toEqual({
      awareness: 2,
      doc: 3,
      file: 1,
    });
  });

  test("incrementMessage updates Prometheus counters", () => {
    const registry = new MockRegistry() as any;
    const collector = new MetricsCollector(registry);

    collector.incrementMessage("doc");
    collector.incrementMessage("awareness");
    collector.incrementMessage("doc");

    // Check that the counters were incremented
    expect(collector.messagesTotal.getTotalValue()).toBe(3); // Should be 3 total messages
    expect(collector.totalMessagesProcessed.getTotalValue()).toBe(3); // Should also be 3
  });

  test("getMessageCountsByType returns accurate breakdown", () => {
    const registry = new MockRegistry() as any;
    const collector = new MetricsCollector(registry);

    // Simulate various message types
    const messageTypes = [
      "doc",
      "awareness",
      "file",
      "ack",
      "doc",
      "awareness",
      "doc",
    ];

    for (const type of messageTypes) collector.incrementMessage(type);

    const breakdown = collector.getMessageCountsByType();
    expect(breakdown).toEqual({
      doc: 3,
      awareness: 2,
      file: 1,
      ack: 1,
    });
  });

  describe("Document Size Metrics", () => {
    test("recordDocumentSize updates gauge", () => {
      const registry = new MockRegistry() as any;
      const collector = new MetricsCollector(registry);

      collector.recordDocumentSize("doc1", 100, false);

      // Need to access Gauge value with labels
      expect(
        collector.documentSizeBytes.getValue({
          documentId: "doc1",
          encrypted: "false",
        }),
      ).toBe(100);

      collector.recordDocumentSize("doc1", 150, false);
      expect(
        collector.documentSizeBytes.getValue({
          documentId: "doc1",
          encrypted: "false",
        }),
      ).toBe(150);
    });

    test("incrementSizeWarning updates counter", () => {
      const registry = new MockRegistry() as any;
      const collector = new MetricsCollector(registry);

      collector.incrementSizeWarning("doc1");
      expect(
        collector.documentSizeWarningTotal.getValue({ documentId: "doc1" }),
      ).toBe(1);

      collector.incrementSizeWarning("doc1");
      expect(
        collector.documentSizeWarningTotal.getValue({ documentId: "doc1" }),
      ).toBe(2);
    });

    test("incrementSizeLimitExceeded updates counter", () => {
      const registry = new MockRegistry() as any;
      const collector = new MetricsCollector(registry);

      collector.incrementSizeLimitExceeded("doc1");
      expect(
        collector.documentSizeLimitExceededTotal.getValue({
          documentId: "doc1",
        }),
      ).toBe(1);
    });
  });

  describe("Rate Limit Metrics", () => {
    test("recordRateLimitExceeded updates counter and recent events", () => {
      const registry = new MockRegistry() as any;
      const collector = new MetricsCollector(registry);

      collector.recordRateLimitExceeded("user1", "doc1", "user");

      // Check counter
      expect(
        collector.rateLimitExceededTotal.getValue({
          userId: "user1",
          documentId: "doc1",
          trackBy: "user",
        }),
      ).toBe(1);

      // Check recent events
      const events = collector.getRateLimitRecentEvents();
      expect(events.length).toBe(1);
      expect(events[0].userId).toBe("user1");
      expect(events[0].documentId).toBe("doc1");
      expect(events[0].trackBy).toBe("user");
      expect(events[0].timestamp).toBeDefined();
    });

    test("getRateLimitTopOffenders returns sorted list", () => {
      const registry = new MockRegistry() as any;
      const collector = new MetricsCollector(registry);

      // user1: 3 times
      collector.recordRateLimitExceeded("user1", "doc1", "user");
      collector.recordRateLimitExceeded("user1", "doc1", "user");
      collector.recordRateLimitExceeded("user1", "doc1", "user");

      // user2: 1 time
      collector.recordRateLimitExceeded("user2", "doc2", "user");

      // user3: 5 times
      for (let i = 0; i < 5; i++) {
        collector.recordRateLimitExceeded("user3", "doc3", "user");
      }

      const offenders = collector.getRateLimitTopOffenders(2);
      expect(offenders.length).toBe(2);

      // Should be user3 (5) then user1 (3)
      expect(offenders[0].userId).toBe("user3");
      expect(offenders[0].count).toBe(5);

      expect(offenders[1].userId).toBe("user1");
      expect(offenders[1].count).toBe(3);
    });

    test("rateLimitRecentEvents is capped", () => {
      const registry = new MockRegistry() as any;
      const collector = new MetricsCollector(registry);

      // Add 105 events
      for (let i = 0; i < 105; i++) {
        collector.recordRateLimitExceeded(`user${i}`, "doc1", "user");
      }

      const events = collector.getRateLimitRecentEvents(200);
      expect(events.length).toBe(100);

      // Should be the most recent ones (user104 to user5)
      // Since we unshift, index 0 is the newest (user104)
      expect(events[0].userId).toBe("user104");
    });
  });
});
