import { describe, expect, it } from "bun:test";

import { getDurableObjectWebsocketHooks } from "./websocket";

/**
 * The crossws Cloudflare Durable Object adapter drops the `context` returned
 * by the `upgrade` hook, so `getDurableObjectWebsocketHooks` stashes it per
 * request and re-applies it to `peer.context` before the underlying `open`
 * runs. These tests exercise that wiring without a real workerd adapter.
 */
describe("getDurableObjectWebsocketHooks", () => {
  const makeHooks = (onUpgrade: (request: Request) => Promise<any>) => {
    const server = {
      async createClient({ id }: { id: string }) {
        return { id };
      },
    };
    return getDurableObjectWebsocketHooks({
      server: server as any,
      onUpgrade,
    });
  };

  const makePeer = (request: Request) =>
    ({
      id: "peer-1",
      request,
      context: {} as Record<string, unknown>,
      send: () => 1,
      close: () => {},
      websocket: {},
    }) as any;

  it("re-applies the upgrade context to peer.context before open", async () => {
    const hooks = makeHooks(async () => ({
      context: { userId: "alice", room: "docs" },
    }));

    const request = new Request("http://do/ws");
    // The same Request object flows from upgrade into the peer.
    await hooks.upgrade!(request as any);

    const peer = makePeer(request);
    await hooks.open!(peer);

    expect(peer.context.userId).toBe("alice");
    expect(peer.context.room).toBe("docs");
  });

  it("does not clobber peer.context when upgrade returns no context", async () => {
    const hooks = makeHooks(async () => ({}) as any);

    const request = new Request("http://do/ws");
    await hooks.upgrade!(request as any);

    const peer = makePeer(request);
    peer.context.preset = "kept";
    await hooks.open!(peer);

    expect(peer.context.preset).toBe("kept");
  });

  it("keeps contexts isolated per request", async () => {
    let n = 0;
    const hooks = makeHooks(async () => ({
      context: { userId: `user-${n++}` },
    }));

    const reqA = new Request("http://do/ws?a");
    const reqB = new Request("http://do/ws?b");
    await hooks.upgrade!(reqA as any);
    await hooks.upgrade!(reqB as any);

    const peerB = makePeer(reqB);
    await hooks.open!(peerB);
    const peerA = makePeer(reqA);
    await hooks.open!(peerA);

    // Each peer gets the context stashed for its own request, not the other's.
    expect(peerA.context.userId).toBe("user-0");
    expect(peerB.context.userId).toBe("user-1");
  });
});
