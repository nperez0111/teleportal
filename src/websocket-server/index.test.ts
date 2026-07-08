import { describe, expect, it } from "bun:test";
import { DocMessage } from "teleportal";
import { getWebsocketHandlers, tokenAuthenticatedWebsocketHandler } from "./index";

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

describe("getWebsocketHandlers connection lifecycle", () => {
  function makeMockServer() {
    const created: any[] = [];
    const disconnected: string[] = [];
    const server = {
      createClient: async ({ id }: { id: string }) => {
        const client = { id, send: () => {} };
        created.push(client);
        return client;
      },
      disconnectClient: (id: string) => {
        disconnected.push(id);
      },
    } as any;
    return { server, created, disconnected };
  }

  function makeMockPeer(id: string) {
    const sent: Uint8Array[] = [];
    let closed = false;
    const peer = {
      id,
      context: {} as any,
      websocket: { bufferedAmount: 0 },
      send: (chunk: Uint8Array) => {
        sent.push(chunk);
        return chunk.byteLength;
      },
      close: () => {
        closed = true;
      },
    };
    return { peer, sent, isClosed: () => closed };
  }

  it("creates a client on open and bridges incoming messages to the channel", async () => {
    const { server, created } = makeMockServer();
    let messageHookRan = false;
    const hooks = getWebsocketHandlers({
      server,
      onUpgrade: async () => ({ context: { userId: "u", room: "r" } as any }),
      onMessage: async () => {
        messageHookRan = true;
      },
    });

    const { peer } = makeMockPeer("peer-1");
    await hooks.open!(peer as any);

    // open() must have registered a client and wired up per-peer state.
    expect(created).toHaveLength(1);
    expect(peer.context.client).toBeDefined();
    expect(peer.context.channel?.send).toBeInstanceOf(Function);

    const encoded = new DocMessage("doc", { type: "sync-done" }, { clientId: "c" } as any).encoded;
    await hooks.message!(peer as any, { uint8Array: () => encoded } as any);
    expect(messageHookRan).toBe(true);
  });

  it("write() forwards to peer.send and close() closes the socket", async () => {
    const { server } = makeMockServer();
    const hooks = getWebsocketHandlers({
      server,
      onUpgrade: async () => ({ context: {} as any }),
    });

    const { peer, sent, isClosed } = makeMockPeer("peer-2");
    await hooks.open!(peer as any);

    const chunk = new Uint8Array([1, 2, 3]);
    peer.context.transport.write(chunk);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(chunk);

    peer.context.transport.close();
    expect(isClosed()).toBe(true);
  });

  it("disconnects the client and closes the channel on close", async () => {
    const { server, disconnected } = makeMockServer();
    let disconnectHookRan = false;
    const hooks = getWebsocketHandlers({
      server,
      onUpgrade: async () => ({ context: {} as any }),
      onDisconnect: async () => {
        disconnectHookRan = true;
      },
    });

    const { peer } = makeMockPeer("peer-3");
    await hooks.open!(peer as any);
    await hooks.close!(peer as any, {} as any);

    expect(disconnectHookRan).toBe(true);
    expect(disconnected).toContain("peer-3");
  });

  it("closes the peer when createClient fails during open", async () => {
    const server = {
      createClient: async () => {
        throw new Error("boom");
      },
      disconnectClient: () => {},
    } as any;
    const hooks = getWebsocketHandlers({
      server,
      onUpgrade: async () => ({ context: {} as any }),
    });

    const { peer, isClosed } = makeMockPeer("peer-4");
    await hooks.open!(peer as any);

    // A failed open must not leave the socket dangling.
    expect(isClosed()).toBe(true);
  });
});

describe("tokenAuthenticatedWebsocketHandler", () => {
  const tokenManager = {
    verifyToken: async (token: string) => {
      if (token === "valid") {
        return { valid: true as const, payload: { userId: "u", room: "r" }, error: undefined };
      }
      return { valid: false as const, payload: undefined, error: "invalid" };
    },
  } as any;

  it("rejects an upgrade with an invalid token", async () => {
    const hooks = tokenAuthenticatedWebsocketHandler({ server: {} as any, tokenManager });
    const request = new Request("http://example.com/ws?token=nope");
    await expect(hooks.upgrade!(request)).rejects.toBeInstanceOf(Response);
  });

  it("merges context and headers returned by a custom onUpgrade hook", async () => {
    const hooks = tokenAuthenticatedWebsocketHandler({
      server: {} as any,
      tokenManager,
      hooks: {
        onUpgrade: async () => ({
          context: { extra: "from-hook" } as any,
          headers: { "x-custom": "yes" },
        }),
      },
    });

    const request = new Request("http://example.com/ws?token=valid");
    const result = (await hooks.upgrade!(request)) as {
      context: Record<string, unknown>;
      headers: Record<string, string>;
    };

    // Token payload must still be present.
    expect(result.context.userId).toBe("u");
    // Custom onUpgrade context must be merged in, not discarded.
    expect(result.context.extra).toBe("from-hook");
    // Custom onUpgrade headers must be forwarded.
    expect(result.headers["x-custom"]).toBe("yes");
  });
});
