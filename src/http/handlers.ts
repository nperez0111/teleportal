import { uuidv4 } from "lib0/random";
import type {
  ClientContext,
  Message,
  MessageArray,
  PubSub,
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
} from "teleportal/transports";
import { getDocumentsFromQueryParams } from "./utils";

/**
 * Creates an SSE endpoint that can be used to stream {@link Message}s to the client.
 */
export function getSSEEndpoint<Context extends ServerContext>({
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
          subscribe: (topic: string) => Promise<void>;
          unsubscribe: (topic?: string) => Promise<void>;
        }
      >;
      client: Client<Context>;
    },
  ) => { document: string; encrypted?: boolean }[];
}) {
  const baseLogger = server.logger.child().withContext({
    name: "sse-endpoint",
  });

  return async (req: Request): Promise<Response> => {
    const clientId =
      req.headers.get("x-teleportal-client-id") ??
      new URL(req.url).searchParams.get("client-id") ??
      uuidv4();
    const logger = baseLogger.child().withContext({
      clientId,
      url: req.url,
    });
    const context = {
      clientId,
      ...(await getContext(req)),
    } as Context;

    logger.trace("sse request");

    const sseTransport = compose(
      getPubSubSource({ context, pubsub: server.pubsub }),
      getSSESink({ context }),
    );

    logger.trace("creating client");
    const client = await server.createClient({
      transport: sseTransport,
      id: context.clientId,
    });

    logger
      .withMetadata({
        clientId: context.clientId,
      })
      .trace("created client");

    // When the request is aborted, destroy the client
    req.signal.addEventListener("abort", async () => {
      logger.trace("aborting");
      await client.destroy();
    });

    client.addListeners({
      "document-added": async (doc) => {
        logger
          .withMetadata({
            documentId: doc.id,
          })
          .trace("sse document-added");
        await sseTransport.subscribe(doc.id);
      },
      "document-removed": async (doc) => {
        logger
          .withMetadata({
            documentId: doc.id,
          })
          .trace("sse document-removed");
        await sseTransport.unsubscribe(doc.id);
      },
      destroy: async () => {
        logger.trace("sse destroy");
        await sseTransport.unsubscribe();
      },
    });

    logger.trace("subscribing to client");
    await sseTransport.subscribe(context.clientId);
    logger.trace("sseTransport subscribed to client");

    logger.trace("getting initial documents");
    Promise.all(
      (
        getInitialDocuments?.(req, {
          clientId: context.clientId,
          transport: sseTransport,
          client,
        }) ?? []
      ).map(({ document, encrypted = false }) =>
        server
          .getOrCreateDocument({
            document,
            context,
            encrypted,
          })
          .then((doc) => {
            logger
              .withMetadata({
                documentId: doc.id,
              })
              .trace("subscribed to document");
            return client.subscribeToDocument(doc);
          }),
      ),
    );

    logger.trace("returning sse response");
    return sseTransport.sseResponse;
  };
}

/**
 * Creates an HTTP endpoint that pipes the {@link Message}s to the
 * {@link getSSEEndpoint} via the {@link PubSub} which is listening by the {@link ClientContext.clientId}.
 */
export function getHTTPPublishSSEEndpoint<Context extends ServerContext>({
  server,
  getContext,
}: {
  server: Server<Context>;
  getContext: (request: Request) => Promise<Omit<Context, "clientId">>;
}) {
  const baseLogger = server.logger.child().withContext({
    name: "http-publish-endpoint",
  });

  return async (req: Request): Promise<Response> => {
    const clientId =
      req.headers.get("x-teleportal-client-id") ??
      new URL(req.url).searchParams.get("client-id");
    const logger = baseLogger.child().withContext({
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
      pubsub: server.pubsub,
      topicResolver: (message) => {
        logger
          .withMetadata({
            messageId: message.id,
            payloadType: message.payload.type,
          })
          .trace("publishing");
        return context.clientId;
      },
    });
    // TODO
    req.signal.addEventListener("abort", async (e) => {
      logger.trace("aborting");
      await pubSubSink.writable.abort(e);
    });

    logger.trace("starting to publish");
    await Promise.all([
      httpSource.handleHTTPRequest(req),
      pipe(httpSource, pubSubSink),
    ]);
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
  const baseLogger = server.logger.child().withContext({
    name: "http-endpoint",
  });

  return async (req: Request): Promise<Response> => {
    const clientId = uuidv4();
    const logger = baseLogger.child().withContext({
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
    });

    logger.trace("client created");

    client.once("destroy", async () => {
      logger.trace("client destroyed");
      // close the transform stream to signal the client that the request is complete
      await transformStream.writable.close();
    });

    logger.trace("handling http request");
    await httpTransport.handleHTTPRequest(req);
    logger.trace("http request handled");

    logger.trace("returning response");
    return new Response(transformStream.readable, {
      headers: {
        "Content-Type": "application/octet-stream",
        "x-powered-by": "teleportal",
        "x-teleportal-client-id": context.clientId,
      },
    });
  };
}
