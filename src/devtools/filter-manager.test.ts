import { describe, expect, it } from "bun:test";
import { AckMessage, DocMessage } from "teleportal";
import type { StateVector } from "teleportal/protocol";
import { FilterManager } from "./filter-manager";
import { SettingsManager } from "./settings-manager";
import type { DevtoolsMessage } from "./types";

let seq = 0;
function wrap(
  message: DocMessage<any> | AckMessage<any>,
  overrides: Partial<DevtoolsMessage> = {},
): DevtoolsMessage {
  return {
    id: `msg-${seq++}`,
    message,
    direction: "received",
    timestamp: Date.now(),
    document: message.document,
    provider: null as any,
    connection: null,
    ...overrides,
  };
}

function step1(doc: string): DocMessage<any> {
  return new DocMessage(doc, { type: "sync-step-1", sv: new Uint8Array([0]) as StateVector });
}

function done(doc: string): DocMessage<any> {
  return new DocMessage(doc, { type: "sync-done" });
}

function ack(id: string): AckMessage<any> {
  return new AckMessage({ type: "ack", messageId: id });
}

describe("FilterManager", () => {
  it("always excludes ack messages from the filtered list", () => {
    const fm = new FilterManager(new SettingsManager());
    const msgs = [wrap(step1("doc-1")), wrap(ack("x"))];
    const filtered = fm.getFilteredMessages(msgs, 1);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].message.type).toBe("doc");
  });

  it("filters by direction", () => {
    const fm = new FilterManager(new SettingsManager());
    const msgs = [
      wrap(step1("doc-1"), { direction: "sent" }),
      wrap(done("doc-1"), { direction: "received" }),
    ];

    fm.updateFilters({ direction: "sent" });
    let filtered = fm.getFilteredMessages(msgs, 1);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].direction).toBe("sent");

    // A different generation invalidates the memoized result.
    fm.updateFilters({ direction: "received" });
    filtered = fm.getFilteredMessages(msgs, 2);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].direction).toBe("received");
  });

  it("filters by documentIds and hidden message types", () => {
    const fm = new FilterManager(new SettingsManager());
    const msgs = [wrap(step1("doc-1")), wrap(step1("doc-2")), wrap(done("doc-1"))];

    fm.updateFilters({ documentIds: ["doc-1"] });
    expect(fm.getFilteredMessages(msgs, 1).every((m) => m.document === "doc-1")).toBe(true);

    fm.updateFilters({ documentIds: [], hiddenMessageTypes: ["sync-step-1"] });
    const filtered = fm.getFilteredMessages(msgs, 2);
    expect(filtered.every((m) => m.message.type === "doc")).toBe(true);
    expect(
      filtered.some((m) => (m.message as DocMessage<any>).payload.type === "sync-step-1"),
    ).toBe(false);
  });

  it("searches payload and document id case-insensitively", () => {
    const fm = new FilterManager(new SettingsManager());
    const msgs = [wrap(step1("alpha")), wrap(step1("beta"))];

    fm.updateFilters({ searchText: "ALPHA" });
    const filtered = fm.getFilteredMessages(msgs, 1);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].document).toBe("alpha");
  });

  it("memoizes filtered results by generation + filter key", () => {
    const fm = new FilterManager(new SettingsManager());
    const msgs = [wrap(step1("doc-1"))];
    const a = fm.getFilteredMessages(msgs, 1);
    const b = fm.getFilteredMessages(msgs, 1);
    expect(a).toBe(b); // same array reference from cache
  });

  it("lists available documents and message types, sorted, excluding acks", () => {
    const fm = new FilterManager(new SettingsManager());
    const msgs = [wrap(step1("doc-b")), wrap(done("doc-a")), wrap(ack("x"))];
    expect(fm.getAvailableDocuments(msgs, 1)).toEqual(["doc-a", "doc-b"]);
    expect(fm.getAvailableMessageTypes(msgs, 1)).toEqual(["sync-done", "sync-step-1"]);
  });

  it("clearFilters resets to defaults", () => {
    const fm = new FilterManager(new SettingsManager());
    fm.updateFilters({ direction: "sent", searchText: "x", documentIds: ["doc-1"] });
    fm.clearFilters();
    const filters = fm.getFilters();
    expect(filters.direction).toBe("all");
    expect(filters.searchText).toBe("");
    expect(filters.documentIds).toEqual([]);
  });

  it("updateFilters rejects mistyped filter values at the type level", () => {
    const fm = new FilterManager(new SettingsManager());
    // Regression guard for the signature: it must be Partial<FilterState>,
    // not Partial<typeof this.getFilters> (which erased all type checking).
    // @ts-expect-error searchText must be a string
    fm.updateFilters({ searchText: 123 });
    // @ts-expect-error documentIds must be a string[]
    fm.updateFilters({ documentIds: "doc-1" });
    // A correctly typed update compiles fine.
    fm.updateFilters({ searchText: "ok", documentIds: ["doc-1"] });
  });
});
