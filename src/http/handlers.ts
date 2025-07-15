import { uuidv4 } from "lib0/random";
import {
  decodeMessageArray,
  encodeMessageArray,
  Message,
  MessageArray,
  Observable,
  RawReceivedMessage,
  ServerContext,
  Source,
  Transport,
} from "teleportal";
import { Server } from "teleportal/server";
import { compose, getHTTPSource, getSSESink } from "teleportal/transports";

export function handleHTTP<Context extends ServerContext>({
  validateRequest,
  onCreateClient,
}: {
  validateRequest: (request: Request) => Promise<Omit<Context, "clientId">>;
  onCreateClient: (ctx: {
    clientId: string;
    transport: Transport<
      Context,
      {
        handleHTTPRequest: (request: Request) => Promise<void>;
      }
    >;
    context: Context;
  }) => Promise<void>;
}): (request: Request) => Promise<Response> {
  return async (req) => {
    const context = {
      ...(await validateRequest(req)),
      clientId: uuidv4(),
    } as Context;

    const sseHTTPTransport = compose(
      getHTTPSource({ context }),
      getSSESink({ context }),
    );

    await onCreateClient({
      context,
      clientId: context.clientId,
      transport: sseHTTPTransport,
    });

    return sseHTTPTransport.sseResponse;
  };
}

export function getSSEHandler<Context extends ServerContext>({
  server,
  validateRequest,
  source = { readable: new ReadableStream() },
  observer,
  getDocumentsToSubscribe,
}: {
  server: Server<Context>;
  validateRequest: (request: Request) => Promise<Omit<Context, "clientId">>;
  /**
   * The source to use for the SSE endpoint, defaults to a dummy source
   */
  source?: Source<Context>;
  observer?: Observable<{
    subscribe: (documentId: string) => void;
    unsubscribe: (documentId: string) => void;
  }>;
  /**
   * Callback function to extract documents to subscribe to from the request with optional encryption flag
   */
  getDocumentsToSubscribe?: (request: Request) => { document: string; encrypted?: boolean }[];
}) {
  return async (req: Request): Promise<Response> => {
    const context = {
      ...(await validateRequest(req)),
      clientId: uuidv4(),
    } as Context;

    const sseTransport = compose(
      // This endpoint does not have a source, so we just create a dummy one
      { readable: new ReadableStream() },
      getSSESink({ context }),
    );

    const client = await server.createClient({
      transport: sseTransport,
      id: context.clientId,
    });

    observer?.addListeners({
      subscribe: (documentId) => {
        const document = server.getDocument(documentId);
        if (!document) {
          throw new Error(`Document ${documentId} not found`);
        }
        client.subscribeToDocument(document);
      },
      unsubscribe: (documentId) => {
        const document = server.getDocument(documentId);
        if (!document) {
          throw new Error(`Document ${documentId} not found`);
        }
        client.unsubscribeFromDocument(document);
      },
    });

    // Use the getDocumentsToSubscribe callback if provided
    if (getDocumentsToSubscribe) {
      const subscribeToDocuments = getDocumentsToSubscribe(req);

      for (const { document, encrypted = false } of subscribeToDocuments) {
        client.subscribeToDocument(
          await server.getOrCreateDocument({
            document,
            context,
            encrypted,
          }),
        );
      }
    }

    // When the request is aborted, destroy the client
    req.signal.addEventListener("abort", () => {
      client.destroy();
      observer?.destroy();
    });

    return sseTransport.sseResponse;
  };
}

export function getHTTPEndpoint<Context extends ServerContext>({
  server,
  validateRequest,
}: {
  server: Server<Context>;
  validateRequest: (request: Request) => Promise<Omit<Context, "clientId">>;
}) {
  return async (req: Request): Promise<Response> => {
    const context = {
      ...(await validateRequest(req)),
      clientId: uuidv4(),
    } as Context;

    const messages: Message[] = [];
    const writable = new WritableStream({
      write: (message) => {
        console.log("writing back to http response", message);
        messages.push(message);
      },
    });
    const httpTransport = compose(getHTTPSource({ context }), {
      writable,
    });

    const client = await server.createClient({
      transport: httpTransport,
      id: context.clientId,
    });

    let cleanup = () => {};
    await Promise.race([
      new Promise(async (resolve) => {
        client.once("destroy", () => {
          console.log("client destroyed");
          resolve(true);
        });

        // TODO might be able to support batching of multiple messages
        await httpTransport.handleHTTPRequest(req);
      }),
      new Promise((resolve) => {
        req.signal.addEventListener("abort", () => {
          resolve(true);
        });
      }),
      new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve(true);
        }, 10000);
        const prevCleanup = cleanup;
        cleanup = () => {
          clearTimeout(timeout);
          prevCleanup();
        };
      }),
    ]);

    console.log("messages", messages.length);
    return new Response(new Blob([encodeMessageArray(messages)]), {
      headers: {
        "Content-Type": "application/octet-stream",
        "x-teleportal-client-id": context.clientId,
        "x-powered-by": "teleportal",
      },
    });
  };
}

export async function decodeHTTPRequest(
  response: Response,
): Promise<RawReceivedMessage[]> {
  const buffer = await response.arrayBuffer();
  return decodeMessageArray(new Uint8Array(buffer) as MessageArray);
}
