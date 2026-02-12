import { uuidv4 } from "lib0/random";
import type {
  ClientContext,
  Message,
  MessageArray,
  PubSub,
  PubSubTopic,
  ServerContext,
  Transport,
} from "teleportal";
import type { Client, Server } from "teleportal/server";
import {
  compose,
  getHTTPSource,
  getPubSubSink,
  getPubSubSource,
  getSSESink,
  pipe,
  toMessageArrayStream,
  withAckTrackingSink,
} from "teleportal/transports";
import { emitWideEvent } from "teleportal/server";
import { getDocumentsFromQueryParams } from "./utils";

/**
 * Creates an SSE endpoint that can be used to stream {@link Message}s to the client.
 */
export function getSSEReaderEndpoint<Context extends ServerContext>({
  server,
  getContext,
  getInitialDocuments = getDocumentsFromQueryParams,
}: {
  /**
   * The {@link Server} to use for creating {@link Client}s.
   */
  server: Server<Context>;
  /**
   * A function that extracts the context from the request.
   */
  getContext: (
    request: Request,
  ) => Omit<Context, "clientId"> | Promise<Omit<Context, "clientId">>;
  /**
   * Callback function to extract documents to subscribe to from the request with optional encryption flag.
   *
   * Defaults to {@link getDocumentsFromQueryParams}
   */
  getInitialDocuments?: (
    request: Request,
    ctx: {
      clientId: string;
      transport: Transport<
        Context,
        {
          subscribe: (topic: PubSubTopic) => Promise<void>;
          unsubscribe: (topic?: PubSubTopic) => Promise<void>;
        }
      >;
      client: Client<Context>;
    },
  ) => { document: string; encrypted?: boolean }[];
}) {
  async function handleSSEReader(req: Request): Promise<Response> {
    const startTime = Date.now();
    const clientId =
      req.headers.get("x-teleportal-client-id") ??
      new URL(req.url).searchParams.get("client-id") ??
      uuidv4();
    const wideEvent: Record<string, unknown> = {
      event_type: "http_sse_reader",
      timestamp: new Date().toISOString(),
      client_id: clientId,
      url: req.url,
      method: req.method,
    };
    try {
      const context = {
        clientId,
        ...(await getContext(req)),
      } as Context;

      const sseSink = getSSESink({ context });

      const sseTransport = compose(
        getPubSubSource({
          getContext: () => context,
          pubSub: server.pubSub,
          sourceId: "sse-" + context.clientId,
        }),
        sseSink,
      );

      const client = await server.createClient({
        transport: sseTransport,
        id: context.clientId,
        abortSignal: req.signal,
      });

      req.signal.addEventListener("abort", async () => {
        await sseTransport.unsubscribe();
      });

      await sseTransport.subscribe(`client/${context.clientId}`);
      const initialDocuments =
        getInitialDocuments?.(req, {
          clientId: context.clientId,
          transport: sseTransport,
          client,
        }) ?? [];
      if (initialDocuments.length > 0) {
        await Promise.all(
          initialDocuments.map(({ document, encrypted = false }) =>
            server.getOrOpenSession(document, {
              encrypted,
              client,
              context,
            }),
          ),
        );
      }
      wideEvent.outcome = "success";
      wideEvent.status_code = 200;
      return sseTransport.sseResponse;
    } catch (error) {
      wideEvent.outcome = "error";
      wideEvent.status_code = 500;
      wideEvent.error = error;
      throw error;
    } finally {
      wideEvent.duration_ms = Date.now() - startTime;
      emitWideEvent(
        (wideEvent.outcome as string) === "error" ? "error" : "info",
        wideEvent,
      );
    }
  }
  return handleSSEReader;
}

/**
 * Creates an HTTP endpoint that pipes the {@link Message}s to the
 * {@link getSSEReaderEndpoint} via the {@link PubSub} which is listening by the {@link ClientContext['clientId']}.
 */
export function getSSEWriterEndpoint<Context extends ServerContext>({
  server,
  getContext,
  ackTimeout = 5000,
}: {
  server: Server<Context>;
  getContext: (
    request: Request,
  ) => Omit<Context, "clientId"> | Promise<Omit<Context, "clientId">>;
  /**
   * Timeout in milliseconds for waiting for ACKs.
   * @default 5000 (5 seconds)
   */
  ackTimeout?: number;
}) {
  return async (req: Request): Promise<Response> => {
    const startTime = Date.now();
    const clientId =
      req.headers.get("x-teleportal-client-id") ??
      new URL(req.url).searchParams.get("client-id");
    const wideEvent: Record<string, unknown> = {
      event_type: "http_sse_writer",
      timestamp: new Date().toISOString(),
      client_id: clientId,
      url: req.url,
      method: req.method,
    };
    try {
      const context = {
        clientId,
        ...(await getContext(req)),
      } as Context;

      if (!context.clientId) {
        wideEvent.outcome = "error";
        wideEvent.status_code = 400;
        wideEvent.error = { message: "No client ID provided" };
        return Response.json(
          { error: "No client ID provided" },
          {
            status: 400,
            headers: { "x-powered-by": "teleportal" },
          },
        );
      }

      const httpSource = getHTTPSource({ context });
      const pubSubSink = getPubSubSink({
        pubSub: server.pubSub,
        topicResolver: () => `client/${context.clientId}`,
        sourceId: "http-writer-" + context.clientId,
      });

      const trackedSink = withAckTrackingSink(pubSubSink, {
        pubSub: server.pubSub,
        ackTopic: `ack/${context.clientId}`,
        sourceId: "http-writer-" + context.clientId,
        ackTimeout,
        abortSignal: req.signal,
      });

      await Promise.all([
        httpSource.handleHTTPRequest(req),
        pipe(httpSource, trackedSink),
      ]);

      try {
        await trackedSink.waitForAcks();
      } catch (error) {
        await trackedSink.unsubscribe();
        wideEvent.outcome = "error";
        wideEvent.status_code = 504;
        wideEvent.error = error;
        return Response.json(
          {
            error: "Failed to receive acknowledgment",
            message: (error as Error).message,
          },
          {
            status: 504,
            headers: {
              "x-teleportal-client-id": context.clientId,
              "x-powered-by": "teleportal",
            },
          },
        );
      }

      await trackedSink.unsubscribe();
      wideEvent.outcome = "success";
      wideEvent.status_code = 200;
      return Response.json(
        { message: "ok" },
        {
          headers: {
            "x-teleportal-client-id": context.clientId,
            "x-powered-by": "teleportal",
          },
        },
      );
    } catch (error) {
      wideEvent.outcome = "error";
      wideEvent.status_code = 500;
      wideEvent.error = error;
      throw error;
    } finally {
      wideEvent.duration_ms = Date.now() - startTime;
      emitWideEvent(
        wideEvent.outcome === "error" ? "error" : "info",
        wideEvent,
      );
    }
  };
}

/**
 * Creates an HTTP endpoint that directly handles {@link Message}s and responds with a {@link Response}
 * containing a {@link ReadableStream} of {@link MessageArray}s.
 */
export function getHTTPEndpoint<Context extends ServerContext>({
  server,
  getContext,
}: {
  server: Server<Context>;
  getContext: (
    request: Request,
  ) => Omit<Context, "clientId"> | Promise<Omit<Context, "clientId">>;
}) {
  return async (req: Request): Promise<Response> => {
    const startTime = Date.now();
    const clientId = uuidv4();
    const wideEvent: Record<string, unknown> = {
      event_type: "http_endpoint",
      timestamp: new Date().toISOString(),
      client_id: clientId,
      url: req.url,
      method: req.method,
    };
    try {
      const context = {
        clientId,
        ...(await getContext(req)),
      } as Context;

      const transformStream = toMessageArrayStream();

      req.signal.addEventListener("abort", async (e) => {
        await transformStream.writable.abort(e);
      });

      const httpTransport = compose(getHTTPSource({ context }), {
        writable: transformStream.writable,
      });

      await server.createClient({
        transport: httpTransport,
        id: context.clientId,
        abortSignal: req.signal,
      });

      await httpTransport.handleHTTPRequest(req);
      wideEvent.outcome = "success";
      wideEvent.status_code = 200;
      return new Response(
        transformStream.readable as ReadableStream<Uint8Array>,
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "x-powered-by": "teleportal",
            "x-teleportal-client-id": context.clientId,
          },
        },
      );
    } catch (error) {
      wideEvent.outcome = "error";
      wideEvent.status_code = 500;
      wideEvent.error = error;
      throw error;
    } finally {
      wideEvent.duration_ms = Date.now() - startTime;
      emitWideEvent(
        wideEvent.outcome === "error" ? "error" : "info",
        wideEvent,
      );
    }
  };
}

/**
 * Returns the health status of the server.
 */
export function getHealthHandler(server: Server<any>) {
  return async (request: Request): Promise<Response> => {
    try {
      const health = await server.getHealth();
      return Response.json(health);
    } catch (error) {
      return Response.json(
        {
          status: "unhealthy",
          timestamp: new Date().toISOString(),
          checks: { server: "unhealthy" },
          error: (error as Error).message,
        },
        { status: 500 },
      );
    }
  };
}

/**
 * Returns the metrics of the server.
 */
export function getMetricsHandler(server: Server<any>) {
  return async (request: Request): Promise<Response> => {
    try {
      const metrics = await server.getMetrics();
      return new Response(metrics, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch {
      return new Response("Metrics collection failed", { status: 500 });
    }
  };
}

/**
 * Returns the status of the server.
 */
export function getStatusHandler(server: Server<any>) {
  return async (request: Request): Promise<Response> => {
    try {
      const status = await server.getStatus();
      return Response.json(status);
    } catch (error) {
      return Response.json(
        { error: "Status retrieval failed", message: (error as Error).message },
        { status: 500 },
      );
    }
  };
}
