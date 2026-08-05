import { describe, expect, it } from "bun:test";
import { RpcClient } from "./rpc-client";

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

    client.sendFireAndForget("doc-1", "presenceUnannounce", { awarenessId: 42 });

    // The message hit connection.send synchronously (before `connected`
    // resolved), so a teardown that destroys the connection on the very next
    // line can no longer drop it.
    expect(sent).toHaveLength(1);
    expect(sent[0].rpcMethod).toBe("presenceUnannounce");
    expect(sent[0].payload.payload).toMatchObject({
      method: "presenceUnannounce",
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
    expect(client.sendFireAndForget("doc-1", "presenceUnannounce", {})).toBeUndefined();
  });
});
