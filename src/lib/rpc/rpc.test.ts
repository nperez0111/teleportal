import { describe, test, expect, mock } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  defineMethod,
  defineProtocol,
  ok,
  err,
  createHandlers,
  createClientExtension,
  RpcOperationError,
  type RpcResult,
  type RpcExtensionContext,
} from "./index";
import type { RpcServerContext } from "teleportal/protocol";

// ---------------------------------------------------------------------------
// Helpers: minimal StandardSchemaV1-compatible validator
// ---------------------------------------------------------------------------

function schema<T>(
  validate: (input: unknown) => { value: T } | { issues: StandardSchemaV1.Issue[] },
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(input: unknown) {
        return validate(input);
      },
    },
  } as unknown as StandardSchemaV1<unknown, T>;
}

function objectSchema<T extends Record<string, unknown>>(): StandardSchemaV1<unknown, T> {
  return schema<T>((input) => {
    if (typeof input === "object" && input !== null) {
      return { value: input as T };
    }
    return { issues: [{ message: "Expected an object" }] };
  });
}

// ---------------------------------------------------------------------------
// ok / err
// ---------------------------------------------------------------------------

describe("ok / err", () => {
  test("ok() creates success result", () => {
    const result = ok({ milestones: [] });
    expect(result).toEqual({ ok: true, value: { milestones: [] }, encrypted: undefined });
  });

  test("ok() with encrypted flag", () => {
    const result = ok({ data: "test" }, { encrypted: true });
    expect(result).toEqual({ ok: true, value: { data: "test" }, encrypted: true });
  });

  test("err() creates failure result", () => {
    const result = err(404, "Not found");
    expect(result).toEqual({
      ok: false,
      error: { statusCode: 404, details: "Not found", payload: undefined },
    });
  });

  test("err() with payload", () => {
    const result = err(400, "Validation failed", { field: "name" });
    expect(result).toEqual({
      ok: false,
      error: { statusCode: 400, details: "Validation failed", payload: { field: "name" } },
    });
  });

  test("discriminated union narrows correctly", () => {
    const result: RpcResult<{ value: number }> = ok({ value: 42 });
    if (result.ok) {
      expect(result.value.value).toBe(42);
    } else {
      throw new Error("Expected ok");
    }
  });
});

// ---------------------------------------------------------------------------
// defineMethod
// ---------------------------------------------------------------------------

describe("defineMethod", () => {
  test("type-first creates method with correct name and kind", () => {
    const method = defineMethod<"testMethod", { id: string }, { name: string }>("testMethod");
    expect(method.name).toBe("testMethod");
    expect(method.kind).toBe("request-response");
    expect(method.requestSchema).toBeUndefined();
    expect(method.responseSchema).toBeUndefined();
  });

  test("type-first streaming", () => {
    const method = defineMethod<"upload", { file: string }, { ok: boolean }, { chunk: number }>(
      "upload",
      { kind: "multipart" },
    );
    expect(method.name).toBe("upload");
    expect(method.kind).toBe("multipart");
  });

  test("schema-first stores schemas", () => {
    const reqSchema = objectSchema<{ id: string }>();
    const resSchema = objectSchema<{ name: string }>();
    const method = defineMethod("testMethod", {
      request: reqSchema,
      response: resSchema,
    });
    expect(method.name).toBe("testMethod");
    expect(method.kind).toBe("request-response");
    expect(method.requestSchema).toBe(reqSchema);
    expect(method.responseSchema).toBe(resSchema);
  });

  test("schema-first streaming stores stream schema", () => {
    const reqSchema = objectSchema<{ fileId: string }>();
    const resSchema = objectSchema<{ allowed: boolean }>();
    const streamSchema = objectSchema<{ chunk: Uint8Array }>();
    const method = defineMethod("upload", {
      request: reqSchema,
      response: resSchema,
      stream: streamSchema,
      kind: "multipart",
    });
    expect(method.kind).toBe("multipart");
    expect(method.streamSchema).toBe(streamSchema);
  });
});

// ---------------------------------------------------------------------------
// defineProtocol
// ---------------------------------------------------------------------------

describe("defineProtocol", () => {
  test("groups methods under a protocol name", () => {
    const list = defineMethod<"itemList", {}, { items: string[] }>("itemList");
    const get = defineMethod<"itemGet", { id: string }, { item: string }>("itemGet");
    const protocol = defineProtocol("items", { list, get });

    expect(protocol.name).toBe("items");
    expect(protocol.methods.list).toBe(list);
    expect(protocol.methods.get).toBe(get);
    expect(protocol.methods.list.name).toBe("itemList");
    expect(protocol.methods.get.name).toBe("itemGet");
  });
});

// ---------------------------------------------------------------------------
// createHandlers
// ---------------------------------------------------------------------------

function mockContext(overrides: Partial<RpcServerContext> = {}): RpcServerContext {
  return {
    server: {} as any,
    documentId: "test-doc",
    session: { storage: {} } as any,
    userId: "user-1",
    ...overrides,
  };
}

describe("createHandlers", () => {
  test("produces RpcHandlerRegistry keyed by wire names", () => {
    const list = defineMethod<"testList", {}, { items: string[] }>("testList");
    const get = defineMethod<"testGet", { id: string }, { item: string }>("testGet");
    const protocol = defineProtocol("test", { list, get });

    const registry = createHandlers(
      protocol,
      {},
      {
        list: () => async () => ok({ items: ["a", "b"] }),
        get: () => async (payload) => ok({ item: payload.id }),
      },
    );

    expect(Object.keys(registry)).toEqual(["testList", "testGet"]);
    expect(typeof registry["testList"].handler).toBe("function");
    expect(typeof registry["testGet"].handler).toBe("function");
  });

  test("handler returns translated success", async () => {
    const method = defineMethod<"ping", { msg: string }, { reply: string }>("ping");
    const protocol = defineProtocol("test", { ping: method });

    const registry = createHandlers(
      protocol,
      {},
      {
        ping: () => async (payload) => ok({ reply: `pong: ${payload.msg}` }),
      },
    );

    const result = await registry["ping"].handler({ msg: "hello" }, mockContext());
    expect(result).toEqual({ response: { reply: "pong: hello" }, encrypted: undefined });
  });

  test("handler returns translated error", async () => {
    const method = defineMethod<"fail", {}, {}>("fail");
    const protocol = defineProtocol("test", { fail: method });

    const registry = createHandlers(
      protocol,
      {},
      {
        fail: () => async () => err(404, "Not found"),
      },
    );

    const result = await registry["fail"].handler({}, mockContext());
    expect(result.response).toEqual({
      type: "error",
      statusCode: 404,
      details: "Not found",
      payload: undefined,
    });
  });

  test("handler catches thrown errors and returns 500", async () => {
    const method = defineMethod<"boom", {}, {}>("boom");
    const protocol = defineProtocol("test", { boom: method });

    const registry = createHandlers(
      protocol,
      {},
      {
        boom: () => async () => {
          throw new Error("Unexpected failure");
        },
      },
    );

    const result = await registry["boom"].handler({}, mockContext());
    expect(result.response).toEqual({
      type: "error",
      statusCode: 500,
      details: "Unexpected failure",
    });
  });

  test("handler catches non-Error throws", async () => {
    const method = defineMethod<"boom", {}, {}>("boom");
    const protocol = defineProtocol("test", { boom: method });

    const registry = createHandlers(
      protocol,
      {},
      {
        boom: () => async () => {
          throw "string error";
        },
      },
    );

    const result = await registry["boom"].handler({}, mockContext());
    expect(result.response).toEqual({
      type: "error",
      statusCode: 500,
      details: "Internal server error",
    });
  });

  test("encrypted flag is preserved through translation", async () => {
    const method = defineMethod<"enc", {}, { data: string }>("enc");
    const protocol = defineProtocol("test", { enc: method });

    const registry = createHandlers(
      protocol,
      {},
      {
        enc: () => async () => ok({ data: "secret" }, { encrypted: true }),
      },
    );

    const result = await registry["enc"].handler({}, mockContext());
    expect(result.encrypted).toBe(true);
    expect(result.response).toEqual({ data: "secret" });
  });

  test("dependencies are passed to handler factories", async () => {
    const method = defineMethod<"greet", { name: string }, { message: string }>("greet");
    const protocol = defineProtocol("test", { greet: method });
    const deps = { prefix: "Hello" };

    const registry = createHandlers(protocol, deps, {
      greet:
        ({ prefix }) =>
        async (payload) =>
          ok({ message: `${prefix}, ${payload.name}!` }),
    });

    const result = await registry["greet"].handler({ name: "World" }, mockContext());
    expect(result.response).toEqual({ message: "Hello, World!" });
  });

  test("init callback is attached to the first handler", () => {
    const a = defineMethod<"a", {}, {}>("a");
    const b = defineMethod<"b", {}, {}>("b");
    const protocol = defineProtocol("test", { a, b });

    const cleanup = mock(() => {});
    const initFn = mock((_server: any, _deps: any) => cleanup);

    const registry = createHandlers(
      protocol,
      {},
      {
        a: () => async () => ok({}),
        b: () => async () => ok({}),
      },
      { init: initFn },
    );

    const firstKey = Object.keys(registry)[0];
    expect(registry[firstKey].init).toBeDefined();

    const mockServer = {} as any;
    const result = registry[firstKey].init!(mockServer);
    expect(initFn).toHaveBeenCalledWith(mockServer, {});
    expect(result).toBe(cleanup);
  });

  test("schema validation rejects invalid payloads with 400", async () => {
    const reqSchema = schema<{ id: string }>((input) => {
      if (typeof input === "object" && input !== null && "id" in input) {
        return { value: input as { id: string } };
      }
      return { issues: [{ message: "Missing required field: id" }] };
    });
    const resSchema = objectSchema<{ name: string }>();

    const method = defineMethod("validated", { request: reqSchema, response: resSchema });
    const protocol = defineProtocol("test", { validated: method });

    const handlerFn = mock(async () => ok({ name: "test" }));
    const registry = createHandlers(
      protocol,
      {},
      {
        validated: () => handlerFn,
      },
    );

    const result = await registry["validated"].handler({}, mockContext());
    expect(handlerFn).not.toHaveBeenCalled();
    expect(result.response).toEqual({
      type: "error",
      statusCode: 400,
      details: "Validation failed",
      payload: {
        issues: [{ message: "Missing required field: id", path: undefined }],
      },
    });
  });

  test("schema validation passes valid payloads through", async () => {
    const reqSchema = schema<{ id: string }>((input) => {
      if (typeof input === "object" && input !== null && "id" in input) {
        return { value: input as { id: string } };
      }
      return { issues: [{ message: "Missing id" }] };
    });
    const resSchema = objectSchema<{ name: string }>();

    const method = defineMethod("validated", { request: reqSchema, response: resSchema });
    const protocol = defineProtocol("test", { validated: method });

    const registry = createHandlers(
      protocol,
      {},
      {
        validated: () => async (payload) => ok({ name: `found: ${(payload as any).id}` }),
      },
    );

    const result = await registry["validated"].handler({ id: "abc" }, mockContext());
    expect(result.response).toEqual({ name: "found: abc" });
  });

  test("schema validation uses coerced value", async () => {
    const reqSchema = schema<{ id: string; normalized: true }>((input) => {
      if (typeof input === "object" && input !== null && "id" in input) {
        return { value: { ...(input as any), normalized: true } };
      }
      return { issues: [{ message: "bad" }] };
    });
    const resSchema = objectSchema<{ result: boolean }>();

    const method = defineMethod("coerce", { request: reqSchema, response: resSchema });
    const protocol = defineProtocol("test", { coerce: method });

    let receivedPayload: unknown;
    const registry = createHandlers(
      protocol,
      {},
      {
        coerce: () => async (payload) => {
          receivedPayload = payload;
          return ok({ result: true });
        },
      },
    );

    await registry["coerce"].handler({ id: "test" }, mockContext());
    expect(receivedPayload).toEqual({ id: "test", normalized: true });
  });

  test("streaming handler registers both handler and streamHandler", async () => {
    const method = defineMethod<
      "upload",
      { fileId: string },
      { allowed: boolean },
      { chunk: number }
    >("upload", { kind: "multipart" });
    const protocol = defineProtocol("test", { upload: method });

    const streamHandlerFn = mock(async () => {});
    const registry = createHandlers(
      protocol,
      {},
      {
        upload: () => ({
          handler: async (_payload) => ok({ allowed: true }),
          streamHandler: streamHandlerFn,
        }),
      },
    );

    expect(registry["upload"].handler).toBeDefined();
    expect(registry["upload"].streamHandler).toBeDefined();
    expect(registry["upload"].streamHandler).toBe(streamHandlerFn);
  });

  test("codecs from defineMethod are passed through to registry entries", () => {
    const requestCodec = {
      encode: (p: { id: string }) => new TextEncoder().encode(JSON.stringify(p)),
      decode: (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as { id: string },
    };
    const responseCodec = {
      encode: (p: { name: string }) => new TextEncoder().encode(JSON.stringify(p)),
      decode: (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as { name: string },
    };

    const method = defineMethod<"binaryGet", { id: string }, { name: string }>("binaryGet", {
      requestCodec,
      responseCodec,
    });
    const protocol = defineProtocol("test", { get: method });

    const registry = createHandlers(
      protocol,
      {},
      {
        get: () => async (payload) => ok({ name: `found: ${payload.id}` }),
      },
    );

    expect(registry["binaryGet"].request).toBeDefined();
    expect(registry["binaryGet"].request!.encode).toBe(requestCodec.encode as any);
    expect(registry["binaryGet"].request!.decode).toBe(requestCodec.decode as any);
    expect(registry["binaryGet"].response).toBeDefined();
    expect(registry["binaryGet"].response!.encode).toBe(responseCodec.encode as any);
    expect(registry["binaryGet"].response!.decode).toBe(responseCodec.decode as any);
    expect(registry["binaryGet"].stream).toBeUndefined();
  });

  test("stream codec is passed through for streaming methods", () => {
    const streamCodec = {
      encode: (p: { chunk: number }) => new TextEncoder().encode(JSON.stringify(p)),
      decode: (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as { chunk: number },
    };

    const method = defineMethod<"upload", {}, {}, { chunk: number }>("upload", {
      kind: "multipart",
      streamCodec,
    });
    const protocol = defineProtocol("test", { upload: method });

    const streamHandlerFn = mock(async () => {});
    const registry = createHandlers(
      protocol,
      {},
      {
        upload: () => ({
          handler: async (_payload) => ok({}),
          streamHandler: streamHandlerFn,
        }),
      },
    );

    expect(registry["upload"].stream).toBeDefined();
    expect(registry["upload"].stream!.encode).toBe(streamCodec.encode as any);
    expect(registry["upload"].stream!.decode).toBe(streamCodec.decode as any);
  });
});

// ---------------------------------------------------------------------------
// createClientExtension
// ---------------------------------------------------------------------------

describe("createClientExtension", () => {
  function mockRpcContext(sendRequestMock?: Function): RpcExtensionContext {
    return {
      rpcClient: {
        sendRequest: sendRequestMock ?? mock(async () => ({})),
        sendStream: mock(async () => {}),
        onMessage: mock(() => () => {}),
        destroy: mock(() => {}),
      } as any,
      document: "test-doc",
      doc: {} as any,
      awareness: {} as any,
      connection: {
        state: { type: "connected" },
        send: mock(async () => {}),
        connected: Promise.resolve(),
        on: mock(() => () => {}),
      },
      synced: Promise.resolve(),
    };
  }

  test("auto-generated client creates pass-through methods", async () => {
    const list = defineMethod<"itemList", { cursor?: string }, { items: string[] }>("itemList");
    const get = defineMethod<"itemGet", { id: string }, { item: string }>("itemGet");
    const protocol = defineProtocol("items", { list, get });

    const sendRequest = mock(async (_doc: string, method: string, payload: any) => {
      if (method === "itemList") return { items: ["a", "b"] };
      if (method === "itemGet") return { item: payload.id };
      throw new Error("Unknown method");
    });

    const factory = createClientExtension(protocol);
    const ext = factory();
    const ctx = mockRpcContext(sendRequest);
    const api = ext.create(ctx);

    const listResult = await api.list({ cursor: "abc" });
    expect(listResult).toEqual({ items: ["a", "b"] });
    expect(sendRequest).toHaveBeenCalledWith(
      "test-doc",
      "itemList",
      { cursor: "abc" },
      {
        encrypted: undefined,
        timeout: undefined,
      },
    );

    const getResult = await api.get({ id: "x" });
    expect(getResult).toEqual({ item: "x" });
  });

  test("auto-generated client excludes streaming methods", () => {
    const simple = defineMethod<"ping", {}, { pong: boolean }>("ping");
    const streaming = defineMethod<"upload", {}, {}, { chunk: number }>("upload", {
      kind: "multipart",
    });
    const protocol = defineProtocol("test", { simple, streaming });

    const factory = createClientExtension(protocol);
    const ext = factory();
    const ctx = mockRpcContext();
    const api = ext.create(ctx);

    expect(typeof (api as any).simple).toBe("function");
    expect((api as any).streaming).toBeUndefined();
  });

  test("custom build function receives typed methods", async () => {
    const list = defineMethod<"itemList", {}, { items: string[] }>("itemList");
    const protocol = defineProtocol("test", { list });

    const sendRequest = mock(async () => ({ items: ["raw"] }));

    const factory = createClientExtension(protocol, {
      build(methods, _ctx) {
        return {
          async getItems(): Promise<string[]> {
            const response = await methods.list({});
            return response.items.map((i) => i.toUpperCase());
          },
        };
      },
    });

    const ext = factory();
    const ctx = mockRpcContext(sendRequest);
    const api = ext.create(ctx);

    const items = await api.getItems();
    expect(items).toEqual(["RAW"]);
  });

  test("handleMessage and handleAck are forwarded", () => {
    const method = defineMethod<"test", {}, {}>("test");
    const protocol = defineProtocol("test", { test: method });

    const handleMessage = mock(() => true);
    const handleAck = mock(() => false);

    const factory = createClientExtension(protocol, {
      build: () => ({}),
      handleMessage,
      handleAck,
    });

    const ext = factory();
    expect(ext.handleMessage).toBe(handleMessage);
    expect(ext.handleAck).toBe(handleAck);
  });

  test("factory returns a new extension instance each call", () => {
    const method = defineMethod<"test", {}, {}>("test");
    const protocol = defineProtocol("test", { test: method });

    const factory = createClientExtension(protocol);
    const ext1 = factory();
    const ext2 = factory();
    expect(ext1).not.toBe(ext2);
  });

  test("encrypted and timeout options forwarded to sendRequest", async () => {
    const method = defineMethod<"enc", {}, {}>("enc");
    const protocol = defineProtocol("test", { enc: method });

    const sendRequest = mock(async () => ({}));
    const factory = createClientExtension(protocol);
    const ext = factory();
    const ctx = mockRpcContext(sendRequest);
    const api = ext.create(ctx);

    await api.enc({}, { encrypted: true, timeout: 5000 });
    expect(sendRequest).toHaveBeenCalledWith(
      "test-doc",
      "enc",
      {},
      {
        encrypted: true,
        timeout: 5000,
      },
    );
  });

  test("auto-generated client wraps errors with RpcOperationError", async () => {
    const method = defineMethod<"itemGet", { id: string }, { item: string }>("itemGet");
    const protocol = defineProtocol("items", { get: method });

    const sendRequest = mock(async () => {
      throw new Error("connection lost");
    });

    const factory = createClientExtension(protocol);
    const ext = factory();
    const ctx = mockRpcContext(sendRequest);
    const api = ext.create(ctx);

    try {
      await api.get({ id: "x" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcOperationError);
      const rpcErr = error as RpcOperationError;
      expect(rpcErr.protocol).toBe("items");
      expect(rpcErr.operation).toBe("get");
      expect(rpcErr.message).toContain("connection lost");
      expect(rpcErr.cause).toBeInstanceOf(Error);
    }
  });

  test("custom wrapError overrides default RpcOperationError", async () => {
    const method = defineMethod<"itemGet", { id: string }, { item: string }>("itemGet");
    const protocol = defineProtocol("items", { get: method });

    const sendRequest = mock(async () => {
      throw new Error("timeout");
    });

    class CustomError extends Error {
      constructor(
        public op: string,
        cause: unknown,
      ) {
        super(`custom: ${op}`, { cause });
      }
    }

    const factory = createClientExtension(protocol, {
      wrapError: (op, error) => new CustomError(op, error),
      build: (methods, _ctx) => ({
        async getItem(id: string) {
          return methods.get({ id });
        },
      }),
    });

    const ext = factory();
    const ctx = mockRpcContext(sendRequest);
    const api = ext.create(ctx);

    try {
      await api.getItem("x");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CustomError);
      expect((error as CustomError).op).toBe("get");
    }
  });
});
