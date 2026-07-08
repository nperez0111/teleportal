import { describe, expect, it } from "bun:test";
import { EventManager } from "./event-manager";
import { SettingsManager } from "./settings-manager";

/** Number of listeners currently attached to a manager's private Set. */
function listenerCount(manager: unknown): number {
  return (manager as { listeners: Set<unknown> }).listeners.size;
}

describe("EventManager lifecycle", () => {
  it("unsubscribes from the SettingsManager on destroy (no listener leak)", () => {
    const settings = new SettingsManager();
    const before = listenerCount(settings);

    const events = new EventManager(settings);
    // Constructing the EventManager subscribes to settings changes.
    expect(listenerCount(settings)).toBe(before + 1);

    events.destroy();
    // destroy() must remove that subscription, or the destroyed manager keeps
    // reacting to settings changes forever (retained via the closure).
    expect(listenerCount(settings)).toBe(before);
  });

  it("stops reacting to settings changes after destroy", () => {
    const settings = new SettingsManager();
    const events = new EventManager(settings);
    events.destroy();

    // A destroyed EventManager should not touch its state when settings change.
    let threw = false;
    try {
      settings.updateMessageLimit(1);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // The generation must not advance for a destroyed manager.
    expect(events.getGeneration()).toBe(0);
  });
});
