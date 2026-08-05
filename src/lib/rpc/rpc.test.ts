import { describe, test, expect, mock } from "bun:test";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  defineMethod,
  defineProtocol,
  ok,
  err,
  createHandlers,
  createClientExtension,
  mergeHandlers,
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
    const method = defineMethod<{ id: string }, { name: string }>();
    // Unnamed until `defineProtocol` assigns the wire name.
    expect(method.name).toBe("");
    expect(method.kind).toBe("request-response");
    expect(method.requestSchema).toBeUndefined();
    expect(method.responseSchema).toBeUndefined();
  });

  test("type-first streaming", () => {
    const method = defineMethod<{ file: string }, { ok: boolean }, { chunk: number }>({
      kind: "multipart",
    });
    expect(method.kind).toBe("multipart");
  });

  test("schema-first stores schemas", () => {
    const reqSchema = objectSchema<{ id: string }>();
    const resSchema = objectSchema<{ name: string }>();
    const method = defineMethod({
      request: reqSchema,
      response: resSchema,
    });
    expect(method.kind).toBe("request-response");
    expect(method.requestSchema).toBe(reqSchema);
    expect(method.responseSchema).toBe(resSchema);
  });

  test("schema-first streaming stores stream schema", () => {
    const reqSchema = objectSchema<{ fileId: string }>();
    const resSchema = objectSchema<{ allowed: boolean }>();
    const streamSchema = objectSchema<{ chunk: Uint8Array }>();
    const method = defineMethod({
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
    const list = defineMethod<{}, { items: string[] }>();
    const get = defineMethod<{ id: string }, { item: string }>();
    const protocol = defineProtocol("items", { list, get });

    expect(protocol.name).toBe("items");
    // Namespacing is what makes a wire name unique across protocols, so the method a
    // protocol exposes is a renamed copy rather than the definition passed in.
    expect(protocol.methods.list.name).toBe("items.list");
    expect(protocol.methods.get.name).toBe("items.get");
    expect(protocol.methods.list.kind).toBe(list.kind);
    expect(protocol.methods.get.kind).toBe(get.kind);
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
    const list = defineMethod<{}, { items: string[] }>();
    const get = defineMethod<{ id: string }, { item: string }>();
    const protocol = defineProtocol("test", { list, get });

    const registry = createHandlers(
      protocol,
      {},
      {
        list: () => async () => ok({ items: ["a", "b"] }),
        get: () => async (payload) => ok({ item: payload.id }),
      },
    );

    expect(Object.keys(registry)).toEqual(["test.list", "test.get"]);
    expect(typeof registry["test.list"].handler).toBe("function");
    expect(typeof registry["test.get"].handler).toBe("function");
  });

  test("handler returns translated success", async () => {
    const method = defineMethod<{ msg: string }, { reply: string }>();
    const protocol = defineProtocol("test", { ping: method });

    const registry = createHandlers(
      protocol,
      {},
      {
        ping: () => async (payload) => ok({ reply: `pong: ${payload.msg}` }),
      },
    );

    const result = await registry["test.ping"].handler!({ msg: "hello" }, mockContext());
    expect(result).toEqual({ response: { reply: "pong: hello" }, encrypted: undefined });
  });

  test("handler returns translated error", async () => {
    const method = defineMethod<{}, {}>();
    const protocol = defineProtocol("test", { fail: method });

    const registry = createHandlers(
      protocol,
      {},
      {
        fail: () => async () => err(404, "Not found"),
      },
    );

    const result = await registry["test.fail"].handler!({}, mockContext());
    expect(result.response).toEqual({
      type: "error",
      statusCode: 404,
      details: "Not found",
      payload: undefined,
    });
  });

  test("handler catches thrown errors and returns 500", async () => {
    const method = defineMethod<{}, {}>();
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

    const result = await registry["test.boom"].handler!({}, mockContext());
    expect(result.response).toEqual({
      type: "error",
      statusCode: 500,
      details: "Unexpected failure",
    });
  });

  test("handler catches non-Error throws", async () => {
    const method = defineMethod<{}, {}>();
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

    const result = await registry["test.boom"].handler!({}, mockContext());
    expect(result.response).toEqual({
      type: "error",
      statusCode: 500,
      details: "Internal server error",
    });
  });

  test("encrypted flag is preserved through translation", async () => {
    const method = defineMethod<{}, { data: string }>();
    const protocol = defineProtocol("test", { enc: method });

    const registry = createHandlers(
      protocol,
      {},
      {
        enc: () => async () => ok({ data: "secret" }, { encrypted: true }),
      },
    );

    const result = await registry["test.enc"].handler!({}, mockContext());
    expect(result.encrypted).toBe(true);
    expect(result.response).toEqual({ data: "secret" });
  });

  test("dependencies are passed to handler factories", async () => {
    const method = defineMethod<{ name: string }, { message: string }>();
    const protocol = defineProtocol("test", { greet: method });
    const deps = { prefix: "Hello" };

    const registry = createHandlers(protocol, deps, {
      greet:
        ({ prefix }) =>
        async (payload) =>
          ok({ message: `${prefix}, ${payload.name}!` }),
    });

    const result = await registry["test.greet"].handler!({ name: "World" }, mockContext());
    expect(result.response).toEqual({ message: "Hello, World!" });
  });

  test("init callback is attached to the first handler", () => {
    const a = defineMethod<{}, {}>();
    const b = defineMethod<{}, {}>();
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

    const mockServer = { on: () => () => {} } as any;
    const result = registry[firstKey].init!(mockServer);
    expect(initFn).toHaveBeenCalledWith(
      mockServer,
      {},
      expect.objectContaining({ get: expect.any(Function), sessions: expect.any(Function) }),
    );

    // The framework wraps the caller's cleanup so it can release session state alongside
    // it, so this is no longer the same function reference — but calling it must still
    // run the caller's cleanup.
    expect(cleanup).not.toHaveBeenCalled();
    result!();
    expect(cleanup).toHaveBeenCalled();
  });

  test("schema validation rejects invalid payloads with 400", async () => {
    const reqSchema = schema<{ id: string }>((input) => {
      if (typeof input === "object" && input !== null && "id" in input) {
        return { value: input as { id: string } };
      }
      return { issues: [{ message: "Missing required field: id" }] };
    });
    const resSchema = objectSchema<{ name: string }>();

    const method = defineMethod({ request: reqSchema, response: resSchema });
    const protocol = defineProtocol("test", { validated: method });

    const handlerFn = mock(async () => ok({ name: "test" }));
    const registry = createHandlers(
      protocol,
      {},
      {
        validated: () => handlerFn,
      },
    );

    const result = await registry["test.validated"].handler!({}, mockContext());
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

    const method = defineMethod({ request: reqSchema, response: resSchema });
    const protocol = defineProtocol("test", { validated: method });

    const registry = createHandlers(
      protocol,
      {},
      {
        validated: () => async (payload) => ok({ name: `found: ${(payload as any).id}` }),
      },
    );

    const result = await registry["test.validated"].handler!({ id: "abc" }, mockContext());
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

    const method = defineMethod({ request: reqSchema, response: resSchema });
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

    await registry["test.coerce"].handler!({ id: "test" }, mockContext());
    expect(receivedPayload).toEqual({ id: "test", normalized: true });
  });

  test("streaming handler registers both handler and streamHandler", async () => {
    const method = defineMethod<{ fileId: string }, { allowed: boolean }, { chunk: number }>({
      kind: "multipart",
    });
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

    expect(registry["test.upload"].handler).toBeDefined();
    expect(registry["test.upload"].streamHandler).toBeDefined();

    // Wrapped rather than passed through by identity, so the stream handler gets the same
    // scoped context as every other handler. It must still delegate.
    const context = mockContext();
    const send = async () => {};
    await registry["test.upload"].streamHandler!({ chunk: 1 }, context, "msg-1", send);
    expect(streamHandlerFn).toHaveBeenCalledWith({ chunk: 1 }, context, "msg-1", send);
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

    const method = defineMethod<{ id: string }, { name: string }>({
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

    expect(registry["test.get"].request).toBeDefined();
    expect(registry["test.get"].request!.encode).toBe(requestCodec.encode as any);
    expect(registry["test.get"].request!.decode).toBe(requestCodec.decode as any);
    expect(registry["test.get"].response).toBeDefined();
    expect(registry["test.get"].response!.encode).toBe(responseCodec.encode as any);
    expect(registry["test.get"].response!.decode).toBe(responseCodec.decode as any);
    expect(registry["test.get"].stream).toBeUndefined();
  });

  test("stream codec is passed through for streaming methods", () => {
    const streamCodec = {
      encode: (p: { chunk: number }) => new TextEncoder().encode(JSON.stringify(p)),
      decode: (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as { chunk: number },
    };

    const method = defineMethod<{}, {}, { chunk: number }>({
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

    expect(registry["test.upload"].stream).toBeDefined();
    expect(registry["test.upload"].stream!.encode).toBe(streamCodec.encode as any);
    expect(registry["test.upload"].stream!.decode).toBe(streamCodec.decode as any);
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
    const list = defineMethod<{ cursor?: string }, { items: string[] }>();
    const get = defineMethod<{ id: string }, { item: string }>();
    const protocol = defineProtocol("items", { list, get });

    const sendRequest = mock(async (_doc: string, method: string, payload: any) => {
      if (method === "items.list") return { items: ["a", "b"] };
      if (method === "items.get") return { item: payload.id };
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
      "items.list",
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
    const simple = defineMethod<{}, { pong: boolean }>();
    const streaming = defineMethod<{}, {}, { chunk: number }>({
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
    const list = defineMethod<{}, { items: string[] }>();
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
    const method = defineMethod<{}, {}>();
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
    const method = defineMethod<{}, {}>();
    const protocol = defineProtocol("test", { test: method });

    const factory = createClientExtension(protocol);
    const ext1 = factory();
    const ext2 = factory();
    expect(ext1).not.toBe(ext2);
  });

  test("encrypted and timeout options forwarded to sendRequest", async () => {
    const method = defineMethod<{}, {}>();
    const protocol = defineProtocol("test", { enc: method });

    const sendRequest = mock(async () => ({}));
    const factory = createClientExtension(protocol);
    const ext = factory();
    const ctx = mockRpcContext(sendRequest);
    const api = ext.create(ctx);

    await api.enc({}, { encrypted: true, timeout: 5000 });
    expect(sendRequest).toHaveBeenCalledWith(
      "test-doc",
      "test.enc",
      {},
      {
        encrypted: true,
        timeout: 5000,
      },
    );
  });

  test("auto-generated client wraps errors with RpcOperationError", async () => {
    const method = defineMethod<{ id: string }, { item: string }>();
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
    const method = defineMethod<{ id: string }, { item: string }>();
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

describe("createHandlers session scope", () => {
  /** A Session/Server pair with just the event surface the scope machinery uses. */
  function mockServerWithSessions() {
    const sessionOpen: Array<(arg: { session: any }) => void> = [];
    const server = {
      on: (event: string, cb: any) => {
        if (event === "session-open") sessionOpen.push(cb);
        return () => {};
      },
    } as any;
    const openSession = (id: string) => {
      const disposeListeners: Array<() => void> = [];
      const session = {
        id,
        on: (event: string, cb: () => void) => {
          if (event === "dispose") disposeListeners.push(cb);
          return () => {};
        },
        dispose: () => disposeListeners.forEach((fn) => fn()),
      } as any;
      sessionOpen.forEach((cb) => cb({ session }));
      return session;
    };
    return { server, openSession };
  }

  const method = defineMethod<{}, { seen: number }>();
  const protocol = defineProtocol("scoped", { ping: method });

  function build(attach?: (state: { seen: number }, session: any) => () => void) {
    return createHandlers<typeof protocol, {}, { seen: number }>(
      protocol,
      {},
      {
        ping: () => async (_payload, ctx) => {
          ctx.state.seen++;
          return ok({ seen: ctx.state.seen });
        },
      },
      { scope: { create: () => ({ seen: 0 }), attach } },
    );
  }

  test("gives each session its own state, reachable as ctx.state", async () => {
    const registry = build();
    const sessionA = { id: "a" } as any;
    const sessionB = { id: "b" } as any;

    await registry["scoped.ping"].handler!({}, mockContext({ session: sessionA }));
    const secondA = await registry["scoped.ping"].handler!({}, mockContext({ session: sessionA }));
    const firstB = await registry["scoped.ping"].handler!({}, mockContext({ session: sessionB }));

    expect((secondA as any).response).toEqual({ seen: 2 });
    expect((firstB as any).response).toEqual({ seen: 1 });
  });

  test("runs a session's teardown when the session disposes", () => {
    // Milestone's hand-rolled version leaked here: its dispose handler dropped the session
    // from the tracked set without running the per-session unsubscribers, and the
    // server-level cleanup then iterated a set the session was no longer in.
    const torn: string[] = [];
    const registry = build((_state, session) => () => torn.push(session.id));
    const { server, openSession } = mockServerWithSessions();
    registry["scoped.ping"].init!(server);

    const session = openSession("a");
    expect(torn).toEqual([]);
    session.dispose();
    expect(torn).toEqual(["a"]);
  });

  test("runs teardown for still-live sessions when the server disposes", () => {
    const torn: string[] = [];
    const registry = build((_state, session) => () => torn.push(session.id));
    const { server, openSession } = mockServerWithSessions();
    const cleanup = registry["scoped.ping"].init!(server);

    openSession("a");
    openSession("b");
    cleanup!();
    expect(torn.sort()).toEqual(["a", "b"]);
  });

  test("tears a session down exactly once", () => {
    const torn: string[] = [];
    const registry = build((_state, session) => () => torn.push(session.id));
    const { server, openSession } = mockServerWithSessions();
    const cleanup = registry["scoped.ping"].init!(server);

    const session = openSession("a");
    session.dispose();
    cleanup!();
    expect(torn).toEqual(["a"]);
  });

  test("keeps two servers' session lifecycles independent", () => {
    // The presence protocol used to hold its tracked-session Set in the factory closure,
    // so one registry shared by two servers gave them one shared set — and the first
    // server's dispose tore down the second server's sessions.
    const torn: string[] = [];
    const registry = build((_state, session) => () => torn.push(session.id));
    const nodeA = mockServerWithSessions();
    const nodeB = mockServerWithSessions();
    const cleanupA = registry["scoped.ping"].init!(nodeA.server);
    const cleanupB = registry["scoped.ping"].init!(nodeB.server);

    nodeA.openSession("a");
    nodeB.openSession("b");

    cleanupA!();
    expect(torn).toEqual(["a"]);

    cleanupB!();
    expect(torn).toEqual(["a", "b"]);
  });

  test("exposes live sessions to init for maintenance sweeps", () => {
    let scope: any;
    const registry = createHandlers<typeof protocol, {}, { seen: number }>(
      protocol,
      {},
      { ping: () => async (_p, ctx) => ok({ seen: ctx.state.seen }) },
      { scope: { create: () => ({ seen: 0 }) }, init: (_server, _deps, s) => void (scope = s) },
    );
    const { server, openSession } = mockServerWithSessions();
    registry["scoped.ping"].init!(server);

    expect(scope.sessions()).toEqual([]);
    const session = openSession("a");
    expect(scope.sessions()).toEqual([session]);
    session.dispose();
    expect(scope.sessions()).toEqual([]);
  });
});

describe("wire-name collisions", () => {
  test("two protocols claiming the same key produce distinct wire names", () => {
    // The registry is one flat map shared by every session, and registries are merged by
    // spreading — so before namespacing, two protocols with a `list` method silently left
    // you with whichever was spread last.
    const a = defineProtocol("comments", { list: defineMethod<{}, {}>() });
    const b = defineProtocol("tasks", { list: defineMethod<{}, {}>() });

    expect(a.methods.list.name).toBe("comments.list");
    expect(b.methods.list.name).toBe("tasks.list");
  });

  test("mergeHandlers throws rather than letting one registry shadow another", () => {
    const protocol = defineProtocol("dup", { list: defineMethod<{}, {}>() });
    const registry = () => createHandlers(protocol, {}, { list: () => async () => ok({}) });

    expect(() => mergeHandlers(registry(), registry())).toThrow(/Duplicate RPC method "dup.list"/);
  });

  test("mergeHandlers combines disjoint registries", () => {
    const a = createHandlers(
      defineProtocol("a", { list: defineMethod<{}, {}>() }),
      {},
      {
        list: () => async () => ok({}),
      },
    );
    const b = createHandlers(
      defineProtocol("b", { list: defineMethod<{}, {}>() }),
      {},
      {
        list: () => async () => ok({}),
      },
    );

    expect(Object.keys(mergeHandlers(a, b)).sort()).toEqual(["a.list", "b.list"]);
  });
});
