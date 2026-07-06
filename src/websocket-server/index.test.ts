import { describe, expect, it } from "bun:test";
import { DocMessage } from "teleportal";
import { getWebsocketHandlers } from "./index";

/**
 * Durable Object hibernation (crossws cloudflare adapter) restores peers with
 * an empty context and never re-runs the `open` hook, so the per-peer
 * channel/client/transport state is gone. The hooks must treat such peers as
 * stale connections instead of throwing.
 */
describe("getWebsocketHandlers with a hibernation-woken peer", () => {
  const makeHooks = () =>
    getWebsocketHandlers({
      // the stale-peer guard must fire before the server is ever touched
      server: {} as any,
      onUpgrade: async () => ({ context: { userId: "u", room: "r" } as any }),
    });

  it("closes the peer on message instead of throwing", async () => {
    const hooks = makeHooks();
    let closed = false;
    const peer = {
      id: "peer-1",
      context: {},
      close: () => {
        closed = true;
      },
      websocket: {},
    } as any;
    const encoded = new DocMessage("doc", { type: "sync-done" }, { clientId: "c" } as any).encoded;

    await hooks.message!(peer, { uint8Array: () => encoded } as any);

    expect(closed).toBe(true);
  });

  it("does not throw on error events", async () => {
    const hooks = makeHooks();
    const peer = { id: "peer-1", context: {}, close: () => {}, websocket: {} } as any;

    await expect(hooks.error!(peer, new Error("boom") as any)).resolves.toBeUndefined();
  });
});
