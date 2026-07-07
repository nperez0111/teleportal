import { describe, expect, it } from "bun:test";
import { PresenceMessage } from "teleportal";
import { PresenceTracker } from "./presence-tracker";

function join(clientId: string, userId: string, awarenessId = 1): PresenceMessage<any> {
  return new PresenceMessage("doc-1", {
    type: "presence-join",
    awarenessId,
    clientId,
    userId,
    data: { cursor: null },
  });
}

function leave(clientId: string, userId: string): PresenceMessage<any> {
  return new PresenceMessage("doc-1", {
    type: "presence-leave",
    awarenessId: 1,
    clientId,
    userId,
    data: {},
  });
}

describe("PresenceTracker", () => {
  it("builds a roster from join/leave messages", () => {
    const tracker = new PresenceTracker();
    expect(tracker.recordMessage(join("conn-1", "alice"))).toBe(true);
    expect(tracker.recordMessage(join("conn-2", "bob"))).toBe(true);

    expect(tracker.getPeers().map((p) => p.userId)).toEqual(["alice", "bob"]);

    expect(tracker.recordMessage(leave("conn-1", "alice"))).toBe(true);
    expect(tracker.getPeers().map((p) => p.userId)).toEqual(["bob"]);

    expect(tracker.getFeed().map((e) => `${e.kind}:${e.userId}`)).toEqual([
      "join:alice",
      "join:bob",
      "leave:alice",
    ]);
  });

  it("does not duplicate a peer on repeated joins", () => {
    const tracker = new PresenceTracker();
    tracker.recordMessage(join("conn-1", "alice"));
    tracker.recordMessage(join("conn-1", "alice"));
    expect(tracker.getPeers()).toHaveLength(1);
    expect(tracker.getFeed()).toHaveLength(1);
  });

  it("upserts peers from heartbeat rosters without removing absent ones", () => {
    const tracker = new PresenceTracker();
    tracker.recordMessage(join("conn-1", "alice"));

    const heartbeat = new PresenceMessage("doc-1", {
      type: "presence-heartbeat",
      clients: [{ awarenessId: 2, clientId: "conn-2", userId: "bob", data: {} }],
    });
    tracker.recordMessage(heartbeat);

    // alice (other node) survives; bob added from the heartbeat.
    expect(tracker.getPeers().map((p) => p.userId)).toEqual(["alice", "bob"]);
  });

  it("clears the roster on disconnect but keeps the feed", () => {
    const tracker = new PresenceTracker();
    tracker.recordMessage(join("conn-1", "alice"));
    expect(tracker.clearPeers()).toBe(true);
    expect(tracker.getPeers()).toHaveLength(0);
    expect(tracker.getFeed()).toHaveLength(1);
  });

  it("ignores non-presence and announce messages", () => {
    const tracker = new PresenceTracker();
    const announce = new PresenceMessage("doc-1", {
      type: "presence-announce",
      awarenessId: 42,
    });
    expect(tracker.recordMessage(announce)).toBe(false);
    expect(tracker.getPeers()).toHaveLength(0);
  });
});
