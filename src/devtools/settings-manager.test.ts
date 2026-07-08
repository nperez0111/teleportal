import { describe, expect, it } from "bun:test";
import { SettingsManager } from "./settings-manager";

describe("SettingsManager", () => {
  it("defaults to a message limit of 200 and empty filters", () => {
    const sm = new SettingsManager();
    const settings = sm.getSettings();
    expect(settings.messageLimit).toBe(200);
    expect(settings.filters).toEqual({
      documentIds: [],
      hiddenMessageTypes: [],
      direction: "all",
      searchText: "",
    });
  });

  it("ignores non-positive message limits", () => {
    const sm = new SettingsManager();
    sm.updateMessageLimit(0);
    expect(sm.getSettings().messageLimit).toBe(200);
    sm.updateMessageLimit(-5);
    expect(sm.getSettings().messageLimit).toBe(200);
    sm.updateMessageLimit(500);
    expect(sm.getSettings().messageLimit).toBe(500);
  });

  it("merges partial filter updates over existing state", () => {
    const sm = new SettingsManager();
    sm.updateFilters({ direction: "sent" });
    sm.updateFilters({ searchText: "hello" });
    const filters = sm.getSettings().filters;
    expect(filters.direction).toBe("sent");
    expect(filters.searchText).toBe("hello");
  });

  it("notifies subscribers on change and stops after unsubscribe", async () => {
    const sm = new SettingsManager();
    let count = 0;
    const unsub = sm.subscribe(() => count++);

    sm.updateFilters({ searchText: "a" });
    await Promise.resolve(); // flush queueMicrotask
    expect(count).toBe(1);

    unsub();
    sm.updateFilters({ searchText: "b" });
    await Promise.resolve();
    expect(count).toBe(1);
  });

  it("does not share mutable default arrays between instances after clearFilters", () => {
    const a = new SettingsManager();
    a.clearFilters();
    // Mutating one instance's cleared filters must not leak into a fresh
    // instance's defaults (the module-level DEFAULT_FILTERS must be isolated).
    a.getSettings().filters.documentIds.push("leaked");

    const b = new SettingsManager();
    expect(b.getSettings().filters.documentIds).toEqual([]);
  });
});
