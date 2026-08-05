import { describe, expect, it } from "bun:test";
import { RpcClient } from "./rpc-client";

/**
 * A connection that answers every request, echoing the request's `id` back as
 * `originalRequestId` — exactly what a real server does.
 *
 * The reply is deferred by a macrotask so concurrent requests are genuinely in
 * flight at the same time. Answering synchronously would let each request
 * settle before the next one is even registered, hiding any collision in the
 * pending-request map.
 */
function echoConnection() {
  const listeners: Array<(message: any) => void> = [];
  const sent: any[] = [];
  return {
    sent,
    on: (_event: string, callback: (message: any) => void) => {
      listeners.push(callback);
      return () => {};
    },
    connected: Promise.resolve(),
    send: async (message: any) => {
      sent.push(message);
      setTimeout(() => {
        for (const listener of listeners) {
          listener({
            type: "rpc",
            requestType: "response",
            originalRequestId: message.id,
            payload: { type: "success", payload: { echoed: message.rpcMethod } },
          });
        }
      }, 0);
    },
    sendStream: () => {},
  };
}

describe("RpcClient.sendFireAndForget", () => {
  it("sends synchronously without awaiting the connected gate", () => {
    const sent: any[] = [];
    // `connected` never resolves during this test: a fire-and-forget send must
    // not wait on it. This is the destroy-path property — `sendRequest` would
    // `await connection.connected`, deferring the send to a microtask that runs
    // after the connection is torn down, dropping the message.
    const connection = {
      on: () => () => {},
      connected: new Promise<void>(() => {}),
      send: async (message: any) => {
        sent.push(message);
      },
      sendStream: () => {},
    };
    const client = new RpcClient(connection as any);

    client.sendFireAndForget("doc-1", "presence.unannounce", { awarenessId: 42 });

    // The message hit connection.send synchronously (before `connected`
    // resolved), so a teardown that destroys the connection on the very next
    // line can no longer drop it.
    expect(sent).toHaveLength(1);
    expect(sent[0].rpcMethod).toBe("presence.unannounce");
    expect(sent[0].payload.payload).toMatchObject({
      method: "presence.unannounce",
      awarenessId: 42,
    });
  });

  it("returns void and registers no pending request", () => {
    // Unlike `sendRequest`, it tracks no in-flight response, so a never-answered
    // fire-and-forget leaves no lingering timeout after destroy.
    const connection = {
      on: () => () => {},
      connected: Promise.resolve(),
      send: async () => {},
      sendStream: () => {},
    };
    const client = new RpcClient(connection as any);
    expect(client.sendFireAndForget("doc-1", "presence.unannounce", {})).toBeUndefined();
  });
});

describe("RpcClient request correlation", () => {
  it("resolves both of two concurrent byte-identical requests", async () => {
    // Two components mounting at once both call e.g. `provider.milestones.list()`.
    // The requests encode to identical bytes, so if the pending-request map is
    // keyed by the content hash the second `set` silently clobbers the first,
    // the single response resolves only the second, and the first caller hangs
    // until its timeout. Correlation must not depend on payload uniqueness.
    const connection = echoConnection();
    const client = new RpcClient(connection as any);

    const [first, second] = await Promise.all([
      client.sendRequest("doc-1", "milestone.list", {}, { timeout: 50 }),
      client.sendRequest("doc-1", "milestone.list", {}, { timeout: 50 }),
    ]);

    expect(first).toEqual({ echoed: "milestone.list" });
    expect(second).toEqual({ echoed: "milestone.list" });
    // Both really were distinct messages on the wire.
    expect(connection.sent).toHaveLength(2);
    expect(connection.sent[0].id).not.toBe(connection.sent[1].id);
  });

  it("gives two separately authored identical-payload requests different ids", async () => {
    // The id is still a content hash — it is the *content* that is now unique,
    // because each authored message carries its own nonce.
    const connection = echoConnection();
    const client = new RpcClient(connection as any);

    await client.sendRequest("doc-1", "milestone.list", {}, { timeout: 50 });
    await client.sendRequest("doc-1", "milestone.list", {}, { timeout: 50 });

    expect(connection.sent[0].id).not.toBe(connection.sent[1].id);
  });
});
