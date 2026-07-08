import { describe, expect, it } from "bun:test";

import { type CrosswsDurableAdapterLike, getDurableObjectHandlers } from "./handlers";

/** Records every adapter call so the delegation can be asserted. */
function makeFakeAdapter() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter: CrosswsDurableAdapterLike = {
    async handleDurableUpgrade(obj, req) {
      calls.push({ method: "upgrade", args: [obj, req] });
      return new Response("upgraded", { status: 101 });
    },
    async handleDurableMessage(obj, ws, message) {
      calls.push({ method: "message", args: [obj, ws, message] });
    },
    async handleDurableClose(obj, ws, code, reason, wasClean) {
      calls.push({ method: "close", args: [obj, ws, code, reason, wasClean] });
    },
    async handleDurablePublish(obj, topic, data, opts) {
      calls.push({ method: "publish", args: [obj, topic, data, opts] });
    },
  };
  return { adapter, calls };
}

describe("getDurableObjectHandlers", () => {
  const obj = { marker: "the-durable-object" };

  it("routes websocket upgrade requests to the crossws adapter", async () => {
    const { adapter, calls } = makeFakeAdapter();
    let httpCalled = false;
    const handlers = getDurableObjectHandlers({
      ws: adapter,
      http: () => {
        httpCalled = true;
        return new Response("http");
      },
    });

    const request = new Request("http://do/ws", { headers: { upgrade: "websocket" } });
    const res = await handlers.fetch(obj, request);

    expect(await res.text()).toBe("upgraded");
    expect(httpCalled).toBe(false);
    expect(calls).toHaveLength(1);
    // The Durable Object instance must be forwarded so the adapter can accept
    // the socket on it.
    expect(calls[0]).toEqual({ method: "upgrade", args: [obj, request] });
  });

  it("routes non-upgrade requests to the HTTP handler", async () => {
    const { adapter, calls } = makeFakeAdapter();
    const handlers = getDurableObjectHandlers({
      ws: adapter,
      http: (req) => new Response(`http:${new URL(req.url).pathname}`),
    });

    const res = await handlers.fetch(obj, new Request("http://do/sync"));

    expect(await res.text()).toBe("http:/sync");
    expect(calls).toHaveLength(0);
  });

  it("is case-insensitive to a non-websocket upgrade header value", async () => {
    const { adapter, calls } = makeFakeAdapter();
    let httpCalled = false;
    const handlers = getDurableObjectHandlers({
      ws: adapter,
      http: () => {
        httpCalled = true;
        return new Response("http");
      },
    });

    // Only the exact "websocket" token routes to the adapter.
    await handlers.fetch(obj, new Request("http://do/", { headers: { upgrade: "h2c" } }));

    expect(httpCalled).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("delegates message/close/publish to the adapter, forwarding the instance", async () => {
    const { adapter, calls } = makeFakeAdapter();
    const handlers = getDurableObjectHandlers({ ws: adapter, http: () => new Response() });
    const ws = { socket: true };

    await handlers.webSocketMessage(obj, ws, "hello");
    await handlers.webSocketClose(obj, ws, 1000, "bye", true);
    await handlers.webSocketPublish(obj, "topic", { n: 1 }, { retain: true });

    expect(calls).toEqual([
      { method: "message", args: [obj, ws, "hello"] },
      { method: "close", args: [obj, ws, 1000, "bye", true] },
      { method: "publish", args: [obj, "topic", { n: 1 }, { retain: true }] },
    ]);
  });
});
