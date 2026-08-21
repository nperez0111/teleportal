import { describe, expect, it } from "bun:test";
import { RpcMessage } from "teleportal";
import { PresenceTracker } from "./presence-tracker";

function push(method: string, payload: unknown): RpcMessage<any> {
  return new RpcMessage("doc-1", { type: "success", payload }, method, "response", undefined);
}

function join(clientId: string, userId: string, awarenessId = 1): RpcMessage<any> {
  return push("presence.join", { awarenessId, clientId, userId, data: { cursor: null } });
}

function leave(clientId: string, userId: string): RpcMessage<any> {
  return push("presence.leave", { awarenessId: 1, clientId, userId, data: {} });
}

describe("PresenceTracker", () => {
  it("builds a roster from join/leave pushes", () => {
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

  it("upserts peers from roster snapshots without removing absent ones", () => {
    const tracker = new PresenceTracker();
    tracker.recordMessage(join("conn-1", "alice"));

    const roster = push("presence.roster", {
      clients: [{ awarenessId: 2, clientId: "conn-2", userId: "bob", data: {} }],
    });
    tracker.recordMessage(roster);

    // alice (other node) survives; bob added from the roster.
    expect(tracker.getPeers().map((p) => p.userId)).toEqual(["alice", "bob"]);
  });

  it("clears the roster on disconnect but keeps the feed", () => {
    const tracker = new PresenceTracker();
    tracker.recordMessage(join("conn-1", "alice"));
    expect(tracker.clearPeers()).toBe(true);
    expect(tracker.getPeers()).toHaveLength(0);
    expect(tracker.getFeed()).toHaveLength(1);
  });

  it("ignores announce requests, correlated responses, and other rpc methods", () => {
    const tracker = new PresenceTracker();
    const announce = new RpcMessage(
      "doc-1",
      { type: "success", payload: { awarenessId: 42 } },
      "presence.announce",
      "request",
      undefined,
    );
    expect(tracker.recordMessage(announce)).toBe(false);
    // A response correlated to a request is not a push.
    const response = new RpcMessage(
      "doc-1",
      { type: "success", payload: { awarenessId: 1, clientId: "c", userId: "u", data: {} } },
      "presence.join",
      "response",
      "req-1",
    );
    expect(tracker.recordMessage(response)).toBe(false);
    const other = push("attribution.push", { contentMap: "x" });
    expect(tracker.recordMessage(other)).toBe(false);
    expect(tracker.getPeers()).toHaveLength(0);
  });
});
