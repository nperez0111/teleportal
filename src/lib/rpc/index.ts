import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  RpcError,
  RpcHandlerRegistry,
  RpcServerContext,
  RpcServerRequestHandler,
  Message,
} from "teleportal/protocol";
import type { Server } from "../../server/server";
import type { RpcExtension, RpcExtensionContext } from "../../providers/rpc-extension";

// ---------------------------------------------------------------------------
// MethodDef — method contract (single source of truth)
// ---------------------------------------------------------------------------

export type MethodKind = "request-response" | "multipart";

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

type HandlerFn<Request, Response> = (
  payload: Request,
  context: RpcServerContext,
) => Promise<RpcResult<Response>> | RpcResult<Response>;

type StreamingHandlerDef<Request, Response, Stream> = {
  handler: (
    payload: Request,
    context: RpcServerContext,
  ) => Promise<RpcResult<Response & { stream?: AsyncIterable<Stream> }>>;
  streamHandler: (
    payload: Stream,
    context: RpcServerContext,
    messageId: string,
    sendMessage: (message: Message<any>) => Promise<void>,
  ) => Promise<void>;
};

type HandlersFor<P extends ProtocolDef<any>, Deps> = {
  [K in keyof P["methods"]]: P["methods"][K]["kind"] extends "multipart"
    ? (
        deps: Deps,
      ) => StreamingHandlerDef<
        P["methods"][K]["_request"],
        P["methods"][K]["_response"],
        P["methods"][K]["_stream"]
      >
    : (deps: Deps) => HandlerFn<P["methods"][K]["_request"], P["methods"][K]["_response"]>;
};

interface CreateHandlersOptions<Deps> {
  init?: (server: Server<any>, deps: Deps) => (() => void) | void;
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

export function createHandlers<P extends ProtocolDef<any>, Deps>(
  protocol: P,
  deps: Deps,
  handlers: HandlersFor<P, Deps>,
  options?: CreateHandlersOptions<Deps>,
): RpcHandlerRegistry {
  const registry: RpcHandlerRegistry = {};
  let initAttached = false;

  for (const key of Object.keys(protocol.methods) as Array<keyof P["methods"] & string>) {
    const methodDef: MethodDef = protocol.methods[key];
    const factory = handlers[key] as (deps: Deps) => any;

    if (methodDef.kind === "multipart") {
      const { handler, streamHandler } = factory(deps) as StreamingHandlerDef<
        unknown,
        unknown,
        unknown
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
          const result = await handler(payload, context);
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
        streamHandler,
      };

      if (methodDef.requestCodec) entry.request = methodDef.requestCodec;
      if (methodDef.responseCodec) entry.response = methodDef.responseCodec;
      if (methodDef.streamCodec) entry.stream = methodDef.streamCodec;

      if (!initAttached && options?.init) {
        initAttached = true;
        entry.init = (server) => options.init!(server, deps);
      }

      registry[methodDef.name] = entry;
    } else {
      const handlerFn = factory(deps) as HandlerFn<unknown, unknown>;

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
          const result = await handlerFn(payload, context);
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

      if (!initAttached && options?.init) {
        initAttached = true;
        entry.init = (server) => options.init!(server, deps);
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
  [K in keyof P["methods"] as P["methods"][K]["kind"] extends "multipart" ? never : K]: (
    payload: P["methods"][K]["_request"],
    options?: { encrypted?: boolean; timeout?: number },
  ) => Promise<P["methods"][K]["_response"]>;
};

type AutoClientFor<P extends ProtocolDef<any>> = {
  [K in keyof P["methods"] as P["methods"][K]["kind"] extends "multipart" ? never : K]: (
    payload: P["methods"][K]["_request"],
    options?: { encrypted?: boolean; timeout?: number },
  ) => Promise<P["methods"][K]["_response"]>;
};

interface ClientExtensionOptions<P extends ProtocolDef<any>, PublicApi> {
  wrapError?: (operation: string, error: unknown) => Error;
  build?: (methods: ClientMethodsFor<P>, ctx: RpcExtensionContext) => PublicApi;
  handleMessage?: (message: any) => boolean | Promise<boolean>;
  handleAck?: (message: any) => boolean | Promise<boolean>;
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
    if (methodDef.kind === "multipart") continue;
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
): () => RpcExtension<AutoClientFor<P>>;

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
): () => RpcExtension<PublicApi | AutoClientFor<P>> {
  return () => ({
    create(ctx: RpcExtensionContext): PublicApi | AutoClientFor<P> {
      const methods = buildTypedMethods(protocol, ctx, options?.wrapError);
      if (options?.build) {
        return options.build(methods, ctx);
      }
      return methods as unknown as AutoClientFor<P>;
    },
    destroy: options?.destroy,
    handleMessage: options?.handleMessage,
    handleAck: options?.handleAck,
  });
}

// Re-export types that consumers will need
export type {
  RpcServerContext,
  RpcHandlerRegistry,
  RpcServerRequestHandler,
  RpcError,
} from "teleportal/protocol";
export type { RpcExtension, RpcExtensionContext } from "../../providers/rpc-extension";
export type { Server } from "../../server/server";
