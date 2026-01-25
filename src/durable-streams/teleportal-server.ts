import type { Message, ServerContext } from "teleportal";
import type { Server } from "teleportal/server";
import { decodeMessageArray, encodeMessageArray } from "teleportal";
import { getBatchingTransform } from "teleportal/transports";
import { DurableStreamStore } from "./store";
import { getDurableStreamsHandler, type DurableStreamsHandler } from "./http";

type ClientState<Context extends ServerContext> = {
  clientId: string;
  /**
   * Latest trusted server context derived from the most recent request.
   */
  context: Context;
  /**
   * Sink for client->server messages (ingested from POST appends).
   */
  ingest: WritableStreamDefaultWriter<Message<Context>>;
};

/**
 * Teleportal server adapter that uses Durable Streams URLs for transport.
 *
 * It exposes a Durable Streams protocol handler at `basePath` (default `/v1/stream`),
 * and reserves the following stream key prefixes for Teleportal messaging:
 *
 * - `teleportal/in/{clientId}`  : client → server
 * - `teleportal/out/{clientId}` : server → client
 *
 * Clients SHOULD create both streams with PUT before use.
 *
 * The server bridges:
 * - POST appends to `teleportal/in/{clientId}` into the Teleportal server pipeline
 * - Teleportal server responses into appends on `teleportal/out/{clientId}`
 */
export function getDurableStreamsTeleportalHandler<
  Context extends ServerContext,
>({
  server,
  getContext,
  store = new DurableStreamStore(),
  basePath = "/v1/stream",
  longPollTimeoutMs,
}: {
  server: Server<Context>;
  getContext: (request: Request) => Promise<Omit<Context, "clientId">>;
  store?: DurableStreamStore;
  basePath?: string;
  longPollTimeoutMs?: number;
}): DurableStreamsHandler {
  const durable = getDurableStreamsHandler({
    store,
    basePath,
    defaultContentType: "application/octet-stream",
    longPollTimeoutMs,
  });

  const clients = new Map<string, ClientState<Context>>();

  const ensureClient = async (clientId: string, ctx: Context) => {
    const existing = clients.get(clientId);
    if (existing) {
      existing.context = ctx;
      return existing;
    }

    // Ensure in/out streams exist.
    store.ensureStream(`teleportal/in/${clientId}`, "application/octet-stream");
    store.ensureStream(`teleportal/out/${clientId}`, "application/octet-stream");

    // Ingest readable (client -> server): we push into a WritableStream.
    const ingestStream = new TransformStream<Message<Context>, Message<Context>>();
    const ingest = ingestStream.writable.getWriter();

    // Outgoing writable (server -> client): append messages to out stream in batches.
    const batching = getBatchingTransform({
      maxBatchSize: 25,
      maxBatchDelay: 5,
    });

    batching.readable.pipeTo(
      new WritableStream<Message[]>({
        write(messages) {
          const bytes = encodeMessageArray(messages as unknown as Message[]);
          store.appendBytes(`teleportal/out/${clientId}`, bytes);
        },
      }),
    );

    const transport = {
      readable: ingestStream.readable,
      writable: batching.writable,
    };

    // Create Teleportal client and connect to server pipeline.
    // This runs asynchronously; messages written to `ingest` will be processed.
    await server.createClient({
      transport: transport as any,
      id: clientId,
    });

    const state: ClientState<Context> = { clientId, context: ctx, ingest };
    clients.set(clientId, state);
    return state;
  };

  const tryParseTeleportalClientId = (req: Request): string | null => {
    const url = new URL(req.url);
    const normalizedBase = basePath.endsWith("/")
      ? basePath.slice(0, -1)
      : basePath;
    if (!url.pathname.startsWith(normalizedBase)) return null;
    const rest = url.pathname.slice(normalizedBase.length);
    const key = decodeURIComponent(rest.startsWith("/") ? rest.slice(1) : rest);
    if (key.startsWith("teleportal/in/")) return key.slice("teleportal/in/".length);
    if (key.startsWith("teleportal/out/")) return key.slice("teleportal/out/".length);
    return null;
  };

  return async (req) => {
    const url = new URL(req.url);
    const normalizedBase = basePath.endsWith("/")
      ? basePath.slice(0, -1)
      : basePath;

    // For any Teleportal-reserved stream, update context and ensure client exists.
    if (url.pathname.startsWith(normalizedBase)) {
      const rest = url.pathname.slice(normalizedBase.length);
      const key = decodeURIComponent(rest.startsWith("/") ? rest.slice(1) : rest);
      const clientId = tryParseTeleportalClientId(req);

      if (clientId) {
        const ctx = {
          clientId,
          ...(await getContext(req)),
        } as Context;

        // Ensure Teleportal client exists and has latest context.
        const state = await ensureClient(clientId, ctx);

        // If this is an append into the inbound stream, ingest into server pipeline
        // using the trusted request context.
        if (
          req.method.toUpperCase() === "POST" &&
          key === `teleportal/in/${clientId}`
        ) {
          // We need the raw bytes as stored by Durable Streams.
          // Clone the request body by reading it here and recreating the Request for durable handler.
          const bytes = new Uint8Array(await req.arrayBuffer());

          // First, let the Durable Streams protocol validate/store it (including non-empty body, Content-Type).
          const durableResponse = await durable(
            new Request(req.url, {
              method: req.method,
              headers: req.headers,
              body: bytes as unknown as BodyInit,
              signal: req.signal,
            }),
          );

          // Only ingest if append succeeded.
          if (durableResponse.status >= 200 && durableResponse.status < 300) {
            const decoded = decodeMessageArray(bytes as any) as Message<any>[];
            const writer = state.ingest;
            for (const m of decoded) {
              // Override untrusted message context.
              Object.assign(m.context, state.context);
              await writer.write(m as Message<Context>);
            }
          }

          return durableResponse;
        }
      }
    }

    return await durable(req);
  };
}

