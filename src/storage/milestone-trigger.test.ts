import { describe, it, expect } from "bun:test";
import type { MilestoneTrigger, DocumentMetadata } from "./types";

describe("MilestoneTrigger Types", () => {
  it("should support time-based triggers", () => {
    const trigger: MilestoneTrigger = {
      id: "trigger-1",
      enabled: true,
      type: "time-based",
      config: { interval: 60_000 },
      autoName: "Every minute",
    };

    expect(trigger.type).toBe("time-based");
    expect(trigger.config.interval).toBe(60_000);
  });

  it("should support update-count triggers", () => {
    const trigger: MilestoneTrigger = {
      id: "trigger-2",
      enabled: true,
      type: "update-count",
      config: { updateCount: 100 },
    };

    expect(trigger.type).toBe("update-count");
    expect(trigger.config.updateCount).toBe(100);
  });

  it("should support event-based triggers", () => {
    const trigger: MilestoneTrigger = {
      id: "trigger-3",
      enabled: true,
      type: "event-based",
      config: {
        event: "client-join",
        condition: (data) => data.clientId !== undefined,
      },
    };

    expect(trigger.type).toBe("event-based");
    expect(trigger.config.event).toBe("client-join");
  });

  it("should be compatible with DocumentMetadata", () => {
    const metadata: DocumentMetadata = {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      encrypted: false,
      milestoneTriggers: [
        {
          id: "trigger-1",
          enabled: true,
          type: "time-based",
          config: { interval: 3_600_000 },
        },
      ],
    };

    expect(metadata.milestoneTriggers).toBeDefined();
    expect(metadata.milestoneTriggers?.length).toBe(1);
  });
});
