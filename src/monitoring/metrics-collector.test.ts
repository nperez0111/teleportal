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

    messageTypes.forEach((type) => collector.incrementMessage(type));

    const breakdown = collector.getMessageCountsByType();
    expect(breakdown).toEqual({
      doc: 3,
      awareness: 2,
      file: 1,
      ack: 1,
    });
  });
});
