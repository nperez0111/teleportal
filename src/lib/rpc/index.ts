import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  RpcError,
  RpcHandlerRegistry,
  RpcMethodQos,
  RpcPushContext,
  RpcServerContext,
  RpcServerRequestHandler,
  Message,
} from "teleportal/protocol";
import type { Server } from "../../server/server";
import type { Session } from "../../server/session";
import type { RpcExtension, RpcExtensionContext } from "../../providers/rpc-extension";

// ---------------------------------------------------------------------------
// MethodDef — method contract (single source of truth)
// ---------------------------------------------------------------------------

export type MethodKind = "request-response" | "multipart" | "push";

export interface Codec<T> {
  encode: (payload: T) => Uint8Array;
  decode: (payload: Uint8Array) => T;
}

export interface MethodDef<
  Name extends string = string,
  Request = unknown,
  Response = unknown,
  Stream = never,
  Kind extends MethodKind = MethodKind,
> {
  readonly name: Name;
  readonly kind: Kind;
  /** Phantom — use `typeof method._request` for the inferred type. */
  readonly _request: Request;
  /** Phantom — use `typeof method._response` for the inferred type. */
  readonly _response: Response;
  /** Phantom — streaming payload type. */
  readonly _stream: Stream;
  readonly requestSchema?: StandardSchemaV1;
  readonly responseSchema?: StandardSchemaV1;
  readonly streamSchema?: StandardSchemaV1;
  readonly requestCodec?: Codec<any>;
  readonly responseCodec?: Codec<any>;
  readonly streamCodec?: Codec<any>;
  /** Delivery QoS, resolved with defaults at definition time. Only set for push methods. */
  readonly qos?: RpcMethodQos;
}

interface CodecOptions<Req = unknown, Res = unknown, Stream = unknown> {
  requestCodec?: Codec<Req>;
  responseCodec?: Codec<Res>;
  streamCodec?: Codec<Stream>;
}

// Overload 1: schema-first (simple)
export function defineMethod<
  Name extends string,
  ReqSchema extends StandardSchemaV1,
  ResSchema extends StandardSchemaV1,
>(
  name: Name,
  options: {
    request: ReqSchema;
    response: ResSchema;
    kind?: "request-response";
  } & CodecOptions<
    StandardSchemaV1.InferOutput<ReqSchema>,
    StandardSchemaV1.InferOutput<ResSchema>
  >,
): MethodDef<
  Name,
  StandardSchemaV1.InferOutput<ReqSchema>,
  StandardSchemaV1.InferOutput<ResSchema>,
  never,
  "request-response"
>;

// Overload 2: schema-first + streaming
export function defineMethod<
  Name extends string,
  ReqSchema extends StandardSchemaV1,
  ResSchema extends StandardSchemaV1,
  StreamSchema extends StandardSchemaV1,
>(
  name: Name,
  options: {
    request: ReqSchema;
    response: ResSchema;
    stream: StreamSchema;
    kind: "multipart";
  } & CodecOptions<
    StandardSchemaV1.InferOutput<ReqSchema>,
    StandardSchemaV1.InferOutput<ResSchema>,
    StandardSchemaV1.InferOutput<StreamSchema>
  >,
): MethodDef<
  Name,
  StandardSchemaV1.InferOutput<ReqSchema>,
  StandardSchemaV1.InferOutput<ResSchema>,
  StandardSchemaV1.InferOutput<StreamSchema>,
  "multipart"
>;

// Overload 3: type-first (simple)
export function defineMethod<Name extends string, Request, Response>(
  name: Name,
  options?: { kind?: "request-response" } & CodecOptions<Request, Response>,
): MethodDef<Name, Request, Response, never, "request-response">;

// Overload 4: type-first + streaming
export function defineMethod<Name extends string, Request, Response, Stream>(
  name: Name,
  options: { kind: "multipart" } & CodecOptions<Request, Response, Stream>,
): MethodDef<Name, Request, Response, Stream, "multipart">;

// Implementation
export function defineMethod(
  name: string,
  options?: {
    request?: StandardSchemaV1;
    response?: StandardSchemaV1;
    stream?: StandardSchemaV1;
    kind?: MethodKind;
    requestCodec?: Codec<any>;
    responseCodec?: Codec<any>;
    streamCodec?: Codec<any>;
  },
): MethodDef<string, unknown, unknown, unknown, MethodKind> {
  return {
    name,
    kind: options?.kind ?? "request-response",
    _request: undefined as never,
    _response: undefined as never,
    _stream: undefined as never,
    requestSchema: options?.request,
    responseSchema: options?.response,
    streamSchema: options?.stream,
    requestCodec: options?.requestCodec,
    responseCodec: options?.responseCodec,
    streamCodec: options?.streamCodec,
  };
}

// ---------------------------------------------------------------------------
// definePush — unsolicited notification methods (server→client and node→node)
// ---------------------------------------------------------------------------

/**
 * Per-push QoS overrides. Push defaults: ephemeral, replicated, acked, deduped —
 * see {@link RpcMethodQos} for what each knob means.
 */
export type PushQosOptions = Partial<RpcMethodQos>;

const PUSH_QOS_DEFAULTS: RpcMethodQos = {
  durability: "ephemeral",
  replicate: true,
  ack: true,
  dedupe: true,
};

// Overload 1: schema-first
export function definePush<Name extends string, PayloadSchema extends StandardSchemaV1>(
  name: Name,
  options: {
    payload: PayloadSchema;
    qos?: PushQosOptions;
    payloadCodec?: Codec<StandardSchemaV1.InferOutput<PayloadSchema>>;
  },
): MethodDef<Name, StandardSchemaV1.InferOutput<PayloadSchema>, void, never, "push">;

// Overload 2: type-first
export function definePush<Name extends string, Payload>(
  name: Name,
  options?: { qos?: PushQosOptions; payloadCodec?: Codec<Payload> },
): MethodDef<Name, Payload, void, never, "push">;

// Implementation
export function definePush(
  name: string,
  options?: {
    payload?: StandardSchemaV1;
    qos?: PushQosOptions;
    payloadCodec?: Codec<any>;
  },
): MethodDef<string, unknown, void, never, "push"> {
  return {
    name,
    kind: "push",
    _request: undefined as never,
    _response: undefined as never,
    _stream: undefined as never,
    requestSchema: options?.payload,
    requestCodec: options?.payloadCodec,
    qos: { ...PUSH_QOS_DEFAULTS, ...options?.qos },
  };
}

// ---------------------------------------------------------------------------
// ProtocolDef — groups related methods under ergonomic keys
// ---------------------------------------------------------------------------

export interface ProtocolDef<
  Methods extends Record<string, MethodDef<string, any, any, any, any>>,
> {
  readonly name: string;
  readonly methods: Methods;
}

export function defineProtocol<
  Methods extends Record<string, MethodDef<string, any, any, any, any>>,
>(name: string, methods: Methods): ProtocolDef<Methods> {
  return { name, methods };
}

// ---------------------------------------------------------------------------
// RpcResult — discriminated union for handler return values
// ---------------------------------------------------------------------------

export type RpcResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly encrypted?: boolean;
      readonly stream?: AsyncIterable<unknown>;
    }
  | {
      readonly ok: false;
      readonly error: {
        statusCode: number;
        details: string;
        payload?: unknown;
      };
    };

export function ok<T>(
  value: T,
  opts?: { encrypted?: boolean; stream?: AsyncIterable<unknown> },
): RpcResult<T> {
  return { ok: true, value, encrypted: opts?.encrypted, stream: opts?.stream };
}

export function err<T = never>(
  statusCode: number,
  details: string,
  payload?: unknown,
): RpcResult<T> {
  return { ok: false, error: { statusCode, details, payload } };
}

// ---------------------------------------------------------------------------
// RpcOperationError — generic error for client-side RPC failures
// ---------------------------------------------------------------------------

export class RpcOperationError extends Error {
  public readonly protocol: string;
  public readonly operation: string;

  constructor(protocol: string, operation: string, cause?: unknown) {
    const message =
      cause instanceof Error
        ? `[${protocol}] Failed to ${operation}: ${cause.message}`
        : `[${protocol}] Failed to ${operation}: ${String(cause)}`;
    super(message, { cause });
    this.name = "RpcOperationError";
    this.protocol = protocol;
    this.operation = operation;
  }
}

// ---------------------------------------------------------------------------
// createHandlers — type-safe server handler registration
// ---------------------------------------------------------------------------

/** A handler context carrying the protocol's per-session state (see {@link SessionScope}). */
type Scoped<Context, State> = Context & { state: State };

type HandlerFn<Request, Response, State> = (
  payload: Request,
  context: Scoped<RpcServerContext, State>,
) => Promise<RpcResult<Response>> | RpcResult<Response>;

type StreamingHandlerDef<Request, Response, Stream, State> = {
  handler: (
    payload: Request,
    context: Scoped<RpcServerContext, State>,
  ) => Promise<RpcResult<Response & { stream?: AsyncIterable<Stream> }>>;
  streamHandler: (
    payload: Stream,
    context: Scoped<RpcServerContext, State>,
    messageId: string,
    sendMessage: (message: Message<any>) => Promise<void>,
  ) => Promise<void>;
};

type PushHandlerFn<Payload, State> = (
  payload: Payload,
  context: Scoped<RpcPushContext, State>,
) =>
  | Promise<{ forwardToLocalClients?: boolean; replicate?: boolean } | void>
  | { forwardToLocalClients?: boolean; replicate?: boolean }
  | void;

type HandlersFor<P extends ProtocolDef<any>, Deps, State> = {
  [K in keyof P["methods"]]: P["methods"][K]["kind"] extends "multipart"
    ? (
        deps: Deps,
      ) => StreamingHandlerDef<
        P["methods"][K]["_request"],
        P["methods"][K]["_response"],
        P["methods"][K]["_stream"],
        State
      >
    : P["methods"][K]["kind"] extends "push"
      ? (deps: Deps) => PushHandlerFn<P["methods"][K]["_request"], State>
      : (deps: Deps) => HandlerFn<P["methods"][K]["_request"], P["methods"][K]["_response"], State>;
};

// ---------------------------------------------------------------------------
// Per-session handler scope
// ---------------------------------------------------------------------------

/**
 * The sessions one {@link Server} currently has open, and this protocol's state for them.
 *
 * A handler registry is built once and shared by every session on the node, so a "handler"
 * is a node-wide function — anything per-document has to be keyed by session. Declaring a
 * {@link SessionScopeOptions} makes the framework own that keying: handlers read
 * `context.state`, and `init` gets this view for maintenance sweeps across sessions.
 */
export interface SessionScope<State> {
  /** This protocol's state for `session`, created on first access. */
  get(session: Session<any>): State;
  /** Every session this server currently has open. */
  sessions(): Session<any>[];
}

export interface SessionScopeOptions<Deps, State> {
  /** Build a session's state. Called once per session, lazily. */
  create: (session: Session<any>, deps: Deps) => State;
  /**
   * Wire up the session's listeners and timers.
   *
   * The returned teardown runs when the session disposes or when the server does,
   * whichever comes first, and runs exactly once either way — so a session that closes
   * under a long-lived server cannot leak its subscriptions.
   */
  attach?: (state: State, session: Session<any>, deps: Deps) => (() => void) | void;
}

interface CreateHandlersOptions<Deps, State> {
  /**
   * Per-session state owned by the framework rather than hand-rolled in a closure.
   *
   * The state map is keyed by session identity, so it is safe to share one registry
   * across servers; the *lifecycle* (which sessions are live, and their listeners) is
   * per-`init`, i.e. per-server.
   */
  scope?: SessionScopeOptions<Deps, State>;
  init?: (server: Server<any>, deps: Deps, scope: SessionScope<State>) => (() => void) | void;
}

function translateResult(result: RpcResult<unknown>): {
  response: unknown | RpcError;
  encrypted?: boolean;
  stream?: AsyncIterable<unknown>;
} {
  if (result.ok) {
    return { response: result.value, encrypted: result.encrypted, stream: result.stream };
  }
  return {
    response: {
      type: "error" as const,
      statusCode: result.error.statusCode,
      details: result.error.details,
      payload: result.error.payload,
    },
  };
}

async function validatePayload(
  schema: StandardSchemaV1,
  payload: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; response: { response: RpcError } }> {
  const result = await schema["~standard"].validate(payload);
  if (result.issues) {
    return {
      ok: false,
      response: {
        response: {
          type: "error",
          statusCode: 400,
          details: "Validation failed",
          payload: {
            issues: result.issues.map((i) => ({
              message: i.message,
              path: i.path?.map((p) =>
                typeof p === "object" && p !== null && "key" in p ? p.key : p,
              ),
            })),
          },
        },
      },
    };
  }
  return { ok: true, value: result.value };
}

export function createHandlers<P extends ProtocolDef<any>, Deps, State = undefined>(
  protocol: P,
  deps: Deps,
  handlers: HandlersFor<P, Deps, State>,
  options?: CreateHandlersOptions<Deps, State>,
): RpcHandlerRegistry {
  const registry: RpcHandlerRegistry = {};
  let initAttached = false;

  // Keyed by session identity, so two servers sharing this registry never see each other's
  // state. Only the *lifecycle* below is per-server.
  const scopeOptions = options?.scope;
  const states = new WeakMap<Session<any>, State>();

  function stateFor(session: Session<any>): State {
    if (!scopeOptions) return undefined as State;
    let state = states.get(session);
    if (state === undefined) {
      state = scopeOptions.create(session, deps);
      states.set(session, state);
    }
    return state;
  }

  /**
   * Stamp the session's state onto the per-call context. The context is built fresh for
   * every dispatch (see `Session`), so assigning in place is safe and allocation-free.
   */
  function scopeContext<C extends { session: unknown }>(context: C): Scoped<C, State> {
    (context as { state?: State }).state = stateFor(context.session as Session<any>);
    return context as Scoped<C, State>;
  }

  /**
   * Wrap the caller's `init` so the framework owns session tracking: state is created when
   * a session opens, and its teardown runs on session dispose or server dispose, whichever
   * comes first.
   */
  function buildInit(): (server: Server<any>) => () => void {
    return (server) => {
      const cleanups: Array<() => void> = [];
      const live = new Set<Session<any>>();
      const detachers = new Map<Session<any>, () => void>();

      const release = (session: Session<any>) => {
        if (!live.delete(session)) return;
        const detach = detachers.get(session);
        detachers.delete(session);
        detach?.();
      };

      if (scopeOptions) {
        cleanups.push(
          server.on("session-open", ({ session }: { session: Session<any> }) => {
            if (live.has(session)) return;
            live.add(session);
            const detach = scopeOptions.attach?.(stateFor(session), session, deps);
            const disposeUnsub = session.on("dispose", () => release(session));
            detachers.set(session, () => {
              disposeUnsub();
              detach?.();
            });
          }),
        );
        cleanups.push(() => {
          // Snapshot first: `release` deletes from `live` as it goes.
          for (const session of Array.from(live)) release(session);
        });
      }

      const scope: SessionScope<State> = {
        get: stateFor,
        sessions: () => [...live],
      };
      const userCleanup = options?.init?.(server, deps, scope);
      if (userCleanup) cleanups.push(userCleanup);

      // Reverse order: the caller's own teardown runs before the sessions it was using
      // are released, and the `session-open` subscription is dropped last.
      return () => {
        for (const cleanup of cleanups.reverse()) cleanup();
      };
    };
  }

  const needsInit = Boolean(options?.init || scopeOptions);

  for (const key of Object.keys(protocol.methods) as Array<keyof P["methods"] & string>) {
    const methodDef: MethodDef = protocol.methods[key];
    const factory = handlers[key] as (deps: Deps) => any;

    if (methodDef.kind === "push") {
      const pushHandlerFn = factory(deps) as PushHandlerFn<unknown, State>;

      const entry: RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext> = {
        pushHandler: async (payload, context) => {
          if (methodDef.requestSchema) {
            const v = await validatePayload(methodDef.requestSchema, payload);
            // A push has no reply channel — an invalid payload is dropped, not
            // answered. `replicate: false` is explicit even though client pushes
            // no longer replicate by default: an invalid payload must never be
            // vouched into the node-to-node plane.
            if (!v.ok) return { forwardToLocalClients: false, replicate: false };
            payload = v.value;
          }
          return pushHandlerFn(payload, scopeContext(context));
        },
        qos: methodDef.qos,
      };

      if (methodDef.requestCodec) entry.request = methodDef.requestCodec;

      if (!initAttached && needsInit) {
        initAttached = true;
        entry.init = buildInit();
      }

      registry[methodDef.name] = entry;
    } else if (methodDef.kind === "multipart") {
      const { handler, streamHandler } = factory(deps) as StreamingHandlerDef<
        unknown,
        unknown,
        unknown,
        State
      >;

      const wrappedHandler: RpcServerRequestHandler<
        unknown,
        unknown,
        unknown,
        RpcServerContext
      >["handler"] = async (payload, context) => {
        if (methodDef.requestSchema) {
          const v = await validatePayload(methodDef.requestSchema, payload);
          if (!v.ok) return v.response;
          payload = v.value;
        }
        try {
          const result = await handler(payload, scopeContext(context));
          if (result.ok) {
            const { stream, ...rest } = result.value as Record<string, unknown> & {
              stream?: AsyncIterable<unknown>;
            };
            return {
              response: rest,
              stream,
              encrypted: result.encrypted,
            };
          }
          return translateResult(result);
        } catch (error) {
          return {
            response: {
              type: "error" as const,
              statusCode: 500,
              details: error instanceof Error ? error.message : "Internal server error",
            },
          };
        }
      };

      const entry: RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext> = {
        handler: wrappedHandler,
        streamHandler: (payload, context, messageId, sendMessage) =>
          streamHandler(payload, scopeContext(context), messageId, sendMessage),
      };

      if (methodDef.requestCodec) entry.request = methodDef.requestCodec;
      if (methodDef.responseCodec) entry.response = methodDef.responseCodec;
      if (methodDef.streamCodec) entry.stream = methodDef.streamCodec;

      if (!initAttached && needsInit) {
        initAttached = true;
        entry.init = buildInit();
      }

      registry[methodDef.name] = entry;
    } else {
      const handlerFn = factory(deps) as HandlerFn<unknown, unknown, State>;

      const wrappedHandler: RpcServerRequestHandler<
        unknown,
        unknown,
        unknown,
        RpcServerContext
      >["handler"] = async (payload, context) => {
        if (methodDef.requestSchema) {
          const v = await validatePayload(methodDef.requestSchema, payload);
          if (!v.ok) return v.response;
          payload = v.value;
        }
        try {
          const result = await handlerFn(payload, scopeContext(context));
          return translateResult(result);
        } catch (error) {
          return {
            response: {
              type: "error" as const,
              statusCode: 500,
              details: error instanceof Error ? error.message : "Internal server error",
            },
          };
        }
      };

      const entry: RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext> = {
        handler: wrappedHandler,
      };

      if (methodDef.requestCodec) entry.request = methodDef.requestCodec;
      if (methodDef.responseCodec) entry.response = methodDef.responseCodec;
      if (methodDef.streamCodec) entry.stream = methodDef.streamCodec;

      if (!initAttached && needsInit) {
        initAttached = true;
        entry.init = buildInit();
      }

      registry[methodDef.name] = entry;
    }
  }

  return registry;
}

// ---------------------------------------------------------------------------
// createClientExtension — type-safe client extension factory
// ---------------------------------------------------------------------------

type ClientMethodsFor<P extends ProtocolDef<any>> = {
  [K in keyof P["methods"] as P["methods"][K]["kind"] extends "multipart" | "push" ? never : K]: (
    payload: P["methods"][K]["_request"],
    options?: { encrypted?: boolean; timeout?: number },
  ) => Promise<P["methods"][K]["_response"]>;
};

interface ClientExtensionOptions<P extends ProtocolDef<any>, PublicApi> {
  wrapError?: (operation: string, error: unknown) => Error;
  build?: (methods: ClientMethodsFor<P>, ctx: RpcExtensionContext) => PublicApi;
  handleMessage?: (message: any) => boolean | Promise<boolean>;
  handleAck?: (message: any) => boolean | Promise<boolean>;
  /**
   * Invoked by the provider on every (re)connect, after the doc sync handshake has been
   * started and before the awareness resync — the deterministic slot for announce-style
   * traffic that must follow sync-step-1.
   */
  onConnect?: () => void | Promise<void>;
  destroy?: () => void;
}

function buildTypedMethods<P extends ProtocolDef<any>>(
  protocol: P,
  ctx: RpcExtensionContext,
  wrapError?: (operation: string, error: unknown) => Error,
): ClientMethodsFor<P> {
  const methods: Record<string, Function> = {};
  const errorWrapper =
    wrapError ?? ((op: string, error: unknown) => new RpcOperationError(protocol.name, op, error));
  for (const key of Object.keys(protocol.methods)) {
    const methodDef: MethodDef = protocol.methods[key];
    if (methodDef.kind === "multipart" || methodDef.kind === "push") continue;
    methods[key] = async (
      payload: unknown,
      options?: { encrypted?: boolean; timeout?: number },
    ) => {
      try {
        return await ctx.rpcClient.sendRequest(ctx.document, methodDef.name, payload as any, {
          encrypted: options?.encrypted,
          timeout: options?.timeout,
        });
      } catch (error) {
        throw errorWrapper(key, error);
      }
    };
  }
  return methods as ClientMethodsFor<P>;
}

// Overload 1: auto-generated client (no build)
export function createClientExtension<P extends ProtocolDef<any>>(
  protocol: P,
): () => RpcExtension<ClientMethodsFor<P>>;

// Overload 2: custom client (with build)
export function createClientExtension<P extends ProtocolDef<any>, PublicApi>(
  protocol: P,
  options: ClientExtensionOptions<P, PublicApi> & {
    build: (methods: ClientMethodsFor<P>, ctx: RpcExtensionContext) => PublicApi;
  },
): () => RpcExtension<PublicApi>;

// Implementation
export function createClientExtension<P extends ProtocolDef<any>, PublicApi>(
  protocol: P,
  options?: ClientExtensionOptions<P, PublicApi>,
): () => RpcExtension<PublicApi | ClientMethodsFor<P>> {
  return () => ({
    create(ctx: RpcExtensionContext): PublicApi | ClientMethodsFor<P> {
      const methods = buildTypedMethods(protocol, ctx, options?.wrapError);
      if (options?.build) {
        return options.build(methods, ctx);
      }
      return methods as unknown as ClientMethodsFor<P>;
    },
    destroy: options?.destroy,
    handleMessage: options?.handleMessage,
    handleAck: options?.handleAck,
    onConnect: options?.onConnect,
  });
}

// Re-export types that consumers will need
export type {
  RpcServerContext,
  RpcHandlerRegistry,
  RpcServerRequestHandler,
  RpcMethodQos,
  RpcPushContext,
  RpcError,
} from "teleportal/protocol";
export type { RpcExtension, RpcExtensionContext } from "../../providers/rpc-extension";
export type { Server } from "../../server/server";
