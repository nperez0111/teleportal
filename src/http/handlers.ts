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
  withAckSink,
  withAckTrackingSink,
} from "teleportal/transports";
import { getDocumentsFromQueryParams } from "./utils";
import { getLogger } from "@logtape/logtape";
import { toErrorDetails } from "../logging";

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
  getContext: (request: Request) => Promise<Omit<Context, "clientId">>;
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
  const baseLogger = getLogger(["teleportal", "http", "sse-reader-endpoint"]);

  return async (req: Request): Promise<Response> => {
    const clientId =
      req.headers.get("x-teleportal-client-id") ??
      new URL(req.url).searchParams.get("client-id") ??
      uuidv4();
    const logger = baseLogger.with({
      clientId,
      url: req.url,
    });
    const context = {
      clientId,
      ...(await getContext(req)),
    } as Context;

    logger.trace("sse request");

    // Wrap the SSE sink to send ACKs after messages are sent
    const sseSink = withAckSink(getSSESink({ context }), {
      pubSub: server.pubSub,
      ackTopic: `ack/${context.clientId}`,
      sourceId: "sse-reader-" + context.clientId,
      context,
    });

    const sseTransport = compose(
      getPubSubSource({
        getContext: () => context,
        pubSub: server.pubSub,
        sourceId: "sse-" + context.clientId,
      }),
      sseSink,
    );

    logger.trace("creating client");
    const client = await server.createClient({
      transport: sseTransport,
      id: context.clientId,
      abortSignal: req.signal,
    });

    logger
      .with({
        clientId: context.clientId,
      })
      .trace("created client");

    // When the request is aborted, unsub from listening to pubSub messages
    req.signal.addEventListener("abort", async () => {
      logger.info("aborting");
      await sseTransport.unsubscribe();
    });

    await sseTransport.subscribe(`client/${context.clientId}`);
    logger
      .with({
        topic: `client/${context.clientId}`,
      })
      .trace("sseTransport subscribed to client");

    logger.trace("getting initial documents");
    const initialDocuments =
      getInitialDocuments?.(req, {
        clientId: context.clientId,
        transport: sseTransport,
        client,
      }) ?? [];
    if (initialDocuments.length > 0) {
      await Promise.all(
        initialDocuments.map(({ document, encrypted = false }) =>
          server
            .getOrOpenSession(document, {
              encrypted,
              client,
              context,
            })
            .then((session) => {
              logger
                .with({
                  sessionId: session.id,
                  documentId: session.documentId,
                })
                .info("subscribed to document");

              return session;
            }),
        ),
      );
    }

    logger.trace("returning sse response");
    return sseTransport.sseResponse;
  };
}

/**
 * Creates an HTTP endpoint that pipes the {@link Message}s to the
 * {@link getSSEReaderEndpoint} via the {@link PubSub} which is listening by the {@link ClientContext.clientId}.
 */
export function getSSEWriterEndpoint<Context extends ServerContext>({
  server,
  getContext,
  ackTimeout = 5000,
}: {
  server: Server<Context>;
  getContext: (request: Request) => Promise<Omit<Context, "clientId">>;
  /**
   * Timeout in milliseconds for waiting for ACKs.
   * @default 5000 (5 seconds)
   */
  ackTimeout?: number;
}) {
  const baseLogger = getLogger(["teleportal", "http", "sse-writer-endpoint"]);

  return async (req: Request): Promise<Response> => {
    const clientId =
      req.headers.get("x-teleportal-client-id") ??
      new URL(req.url).searchParams.get("client-id");
    const logger = baseLogger.with({
      clientId,
      url: req.url,
    });
    logger.trace("http request");
    const context = {
      clientId,
      ...(await getContext(req)),
    } as Context;

    if (!context.clientId) {
      logger.warn("no client id provided");
      return Response.json(
        { error: "No client ID provided" },
        {
          status: 400,
          headers: {
            "x-powered-by": "teleportal",
          },
        },
      );
    }

    const httpSource = getHTTPSource({ context });
    const pubSubSink = getPubSubSink({
      pubSub: server.pubSub,
      topicResolver: (message) => {
        logger
          .with({
            messageId: message.id,
            payloadType: message.payload.type,
          })
          .trace("publishing");
        return `client/${context.clientId}`;
      },
      sourceId: "http-writer-" + context.clientId,
    });

    // Wrap the sink to track messages and wait for ACKs
    const trackedSink = withAckTrackingSink(pubSubSink, {
      pubSub: server.pubSub,
      ackTopic: `ack/${context.clientId}`,
      sourceId: "http-writer-" + context.clientId,
      ackTimeout,
      abortSignal: req.signal,
    });

    logger.trace("starting to publish");
    await Promise.all([
      httpSource.handleHTTPRequest(req),
      pipe(httpSource, trackedSink),
    ]);

    // Wait for all ACKs
    logger.trace("waiting for ACKs");
    try {
      await trackedSink.waitForAcks();
      logger.trace("all ACKs received");
    } catch (error) {
      logger
        .with({ error: toErrorDetails(error) })
        .warn("failed to receive ACK");
      await trackedSink.unsubscribe();

      return Response.json(
        {
          error: "Failed to receive acknowledgment",
          message: (error as Error).message,
        },
        {
          status: 504, // Gateway Timeout
          headers: {
            "x-teleportal-client-id": context.clientId,
            "x-powered-by": "teleportal",
          },
        },
      );
    }

    await trackedSink.unsubscribe();
    logger.trace("finished publishing");

    return Response.json(
      {
        message: "ok",
      },
      {
        headers: {
          "x-teleportal-client-id": context.clientId,
          "x-powered-by": "teleportal",
        },
      },
    );
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
  getContext: (request: Request) => Promise<Omit<Context, "clientId">>;
}) {
  const baseLogger = getLogger(["teleportal", "http", "http-endpoint"]);

  return async (req: Request): Promise<Response> => {
    const clientId = uuidv4();
    const logger = baseLogger.with({
      clientId,
      url: req.url,
    });
    const context = {
      clientId,
      ...(await getContext(req)),
    } as Context;

    logger.trace("http request");

    const transformStream = toMessageArrayStream();

    req.signal.addEventListener("abort", async (e) => {
      logger.trace("aborting");
      await transformStream.writable.abort(e);
    });

    const httpTransport = compose(getHTTPSource({ context }), {
      writable: transformStream.writable,
    });

    logger.trace("creating client");
    const client = await server.createClient({
      transport: httpTransport,
      id: context.clientId,
      abortSignal: req.signal,
    });

    logger
      .with({
        clientId: client.id,
      })
      .trace("client created");

    logger.trace("handling http request");
    await httpTransport.handleHTTPRequest(req);
    logger.trace("http request handled");

    logger.trace("returning response");
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
  };
}
