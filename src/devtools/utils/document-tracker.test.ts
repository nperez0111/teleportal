import { describe, expect, it } from "bun:test";
import { DocMessage } from "teleportal";
import type { StateVector } from "teleportal/protocol";
import { DocumentTracker } from "./document-tracker";

function syncStep1(doc: string): DocMessage<any> {
  return new DocMessage(doc, { type: "sync-step-1", sv: new Uint8Array([0]) as StateVector });
}

function syncDone(doc: string): DocMessage<any> {
  return new DocMessage(doc, { type: "sync-done" });
}

describe("DocumentTracker", () => {
  it("derives the sync phase from the message stream", () => {
    const tracker = new DocumentTracker();
    tracker.addDocument("doc-1", null as any);

    expect(tracker.getDocument("doc-1")!.syncPhase).toBe("idle");

    tracker.recordMessage("doc-1", syncStep1("doc-1"), "sent");
    expect(tracker.getDocument("doc-1")!.syncPhase).toBe("sync-step-1");

    tracker.recordMessage("doc-1", syncDone("doc-1"), "received");
    expect(tracker.getDocument("doc-1")!.syncPhase).toBe("synced");
  });

  it("resets sync phases on disconnect", () => {
    const tracker = new DocumentTracker();
    tracker.addDocument("doc-1", null as any);
    tracker.recordMessage("doc-1", syncDone("doc-1"), "received");
    tracker.resetSyncState();
    expect(tracker.getDocument("doc-1")!.syncPhase).toBe("idle");
  });

  it("accumulates traffic counters by direction", () => {
    const tracker = new DocumentTracker();
    tracker.addDocument("doc-1", null as any);
    const msg = syncStep1("doc-1");
    tracker.recordMessage("doc-1", msg, "sent");
    tracker.recordMessage("doc-1", msg, "received");

    const doc = tracker.getDocument("doc-1")!;
    expect(doc.messageCount).toBe(2);
    expect(doc.bytesSent).toBe(msg.encoded.byteLength);
    expect(doc.bytesReceived).toBe(msg.encoded.byteLength);
  });

  it("links subdocuments to their parent", () => {
    const tracker = new DocumentTracker();
    tracker.addDocument("root", null as any);
    tracker.addDocument("root/sub-1", null as any, "sub-1", {
      parentId: "root",
      isSubdoc: true,
    });

    const sub = tracker.getDocument("root/sub-1")!;
    expect(sub.parentId).toBe("root");
    expect(sub.isSubdoc).toBe(true);
    expect(sub.name).toBe("sub-1");
  });
});
