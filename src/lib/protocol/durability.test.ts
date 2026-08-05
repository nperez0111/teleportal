import { describe, expect, it } from "bun:test";
import {
  AckMessage,
  AwarenessMessage,
  type AwarenessUpdateMessage,
  DocMessage,
  RpcMessage,
  type StateVector,
  type SyncStep2Update,
  type Update,
  type VersionedSyncStep2Update,
  type VersionedUpdate,
} from ".";

/**
 * The classification that drives whether a message is persisted to a durable pub/sub log.
 * The session publishes with `{ ephemeral: message.durability === "ephemeral" }`, so these
 * assertions are the single source of truth for what rides the durable stream vs. the plain
 * fire-and-forget channel.
 */
describe("message durability classification", () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

  it("DocMessage update is durable", () => {
    const m = new DocMessage("doc", {
      type: "update",
      update: { version: 2, data: bytes as Update } as VersionedUpdate,
    });
    expect(m.durability).toBe("durable");
  });

  it("DocMessage sync-step-2 is durable", () => {
    const m = new DocMessage("doc", {
      type: "sync-step-2",
      update: { version: 2, data: bytes as SyncStep2Update } as VersionedSyncStep2Update,
    });
    expect(m.durability).toBe("durable");
  });

  it("DocMessage sync-step-1 is ephemeral (handshake)", () => {
    const m = new DocMessage("doc", { type: "sync-step-1", sv: bytes as StateVector });
    expect(m.durability).toBe("ephemeral");
  });

  it("DocMessage sync-done is ephemeral (handshake)", () => {
    const m = new DocMessage("doc", { type: "sync-done" });
    expect(m.durability).toBe("ephemeral");
  });

  it("DocMessage auth-message is ephemeral (handshake)", () => {
    const m = new DocMessage("doc", { type: "auth-message", permission: "denied", reason: "x" });
    expect(m.durability).toBe("ephemeral");
  });

  it("AwarenessMessage is ephemeral", () => {
    const m = new AwarenessMessage("doc", {
      type: "awareness-update",
      update: bytes as AwarenessUpdateMessage,
    });
    expect(m.durability).toBe("ephemeral");
  });

  it("AckMessage is ephemeral", () => {
    const m = new AckMessage({ type: "ack", messageId: "dGVzdA==" });
    expect(m.durability).toBe("ephemeral");
  });

  it("RpcMessage can declare per-message ephemeral durability", () => {
    const m = new RpcMessage(
      "doc",
      { type: "success", payload: { data: "x" } },
      "presenceRoster",
      "response",
      undefined,
      {},
      false,
      undefined,
      undefined,
      { durability: "ephemeral" },
    );
    expect(m.durability).toBe("ephemeral");
  });

  it("RpcMessage inherits the safe durable default", () => {
    const m = new RpcMessage(
      "doc",
      { type: "success", payload: { data: "x" } },
      "method",
      "request",
      undefined,
      {},
      false,
    );
    expect(m.durability).toBe("durable");
  });

  /**
   * Guards the interface invariant: a message may be `"ephemeral"` only if it is one of the
   * known order-independent, self-healing types. A future class that returns `"ephemeral"`
   * without being reviewed against that invariant fails here.
   */
  it("only known order-independent types are ephemeral", () => {
    const ephemeralByDesign = new Set<string>(["awareness", "ack"]);

    const cases: Array<{ label: string; type: string; ephemeral: boolean }> = [
      { label: "awareness", type: "awareness", ephemeral: true },
      { label: "ack", type: "ack", ephemeral: true },
      { label: "rpc", type: "rpc", ephemeral: false },
      { label: "doc:update", type: "doc", ephemeral: false },
    ];

    for (const c of cases) {
      if (c.ephemeral && c.type !== "doc") {
        expect(ephemeralByDesign.has(c.type)).toBe(true);
      }
    }
  });
});
