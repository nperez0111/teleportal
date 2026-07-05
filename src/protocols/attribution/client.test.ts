import { describe, expect, it } from "bun:test";
import { createContentMap, encodeContentMap } from "teleportal/attribution";
import type { RpcExtensionContext } from "teleportal/rpc";
import { createAttributionRpc } from "./client";

/**
 * Minimal RpcExtensionContext for exercising the attribution extension without
 * a live Provider. `build()` only reads `ctx.document` eagerly; the rpc client
 * is only touched when a method is actually invoked, so a stub suffices here.
 */
function mockCtx(document: string): RpcExtensionContext {
  return {
    rpcClient: { sendRequest: async () => ({}) } as any,
    document,
    doc: {} as any,
    awareness: {} as any,
    connection: {
      state: { type: "connected" },
      send: async () => {},
      connected: Promise.resolve(),
      on: () => () => {},
    },
    synced: Promise.resolve(),
  } as unknown as RpcExtensionContext;
}

function pushMessage(document: string, contentMap: Uint8Array) {
  return {
    rpcMethod: "attributionPush",
    requestType: "response",
    document,
    payload: { type: "success", payload: { contentMap } },
  } as any;
}

describe("attribution client push routing", () => {
  const encoded = encodeContentMap(createContentMap());

  it("routes each push to the instance whose document matches", () => {
    const extA = createAttributionRpc();
    const extB = createAttributionRpc();
    const apiA = extA.create(mockCtx("doc-a"));
    const apiB = extB.create(mockCtx("doc-b"));

    let aCalls = 0;
    let bCalls = 0;
    apiA.mergeIncremental = () => {
      aCalls++;
    };
    apiB.mergeIncremental = () => {
      bCalls++;
    };

    expect(extB.handleMessage!(pushMessage("doc-b", encoded))).toBe(true);
    expect(bCalls).toBe(1);
    expect(aCalls).toBe(0);

    expect(extA.handleMessage!(pushMessage("doc-a", encoded))).toBe(true);
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });

  it("ignores a push addressed to a different document", () => {
    const ext = createAttributionRpc();
    const api = ext.create(mockCtx("doc-a"));
    let calls = 0;
    api.mergeIncremental = () => {
      calls++;
    };

    expect(ext.handleMessage!(pushMessage("doc-b", encoded))).toBe(false);
    expect(calls).toBe(0);
  });

  it("destroying one instance does not disable pushes for another", () => {
    const extA = createAttributionRpc();
    const extB = createAttributionRpc();
    const apiA = extA.create(mockCtx("doc-a"));
    extB.create(mockCtx("doc-b"));

    let aCalls = 0;
    apiA.mergeIncremental = () => {
      aCalls++;
    };

    extB.destroy!();

    expect(extA.handleMessage!(pushMessage("doc-a", encoded))).toBe(true);
    expect(aCalls).toBe(1);
  });
});
