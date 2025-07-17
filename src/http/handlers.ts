import { uuidv4 } from "lib0/random";
import {
  Message,
  Observable,
  RawReceivedMessage,
  ServerContext,
  Source,
  Transport,
} from "teleportal";
import { Document, Server } from "teleportal/server";
import {
  compose,
  createFanOutWriter,
  fromMessageArrayStream,
  getHTTPSource,
  getPubSubSink,
  getPubSubSource,
  getSSESink,
  toMessageArrayStream,
} from "teleportal/transports";

// export function handleHTTP<Context extends ServerContext>({
//   validateRequest,
//   onCreateClient,
// }: {
//   validateRequest: (request: Request) => Promise<Omit<Context, "clientId">>;
//   onCreateClient: (ctx: {
//     clientId: string;
//     transport: Transport<
//       Context,
//       {
//         handleHTTPRequest: (request: Request) => Promise<void>;
//       }
//     >;
//     context: Context;
//   }) => Promise<void>;
// }): (request: Request) => Promise<Response> {
//   return async (req) => {
//     const context = {
//       ...(await validateRequest(req)),
//       clientId: uuidv4(),
//     } as Context;

//     const sseHTTPTransport = compose(
//       getHTTPSource({ context }),
//       getSSESink({ context }),
//     );

//     await onCreateClient({
//       context,
//       clientId: context.clientId,
//       transport: sseHTTPTransport,
//     });

//     return sseHTTPTransport.sseResponse;
//   };
// }

/**
 * Default implementation that extracts document IDs from URL query parameters
 * Supports multiple 'documents' parameters: ?documents=id-1&documents=id-2
 * Also supports comma-separated values: ?documents=id-1,id-2
 * Supports encryption suffix: ?documents=id-1:encrypted,id-2,id-3:encrypted
 * Documents with ":encrypted" suffix will be marked as encrypted
 */
export function getDocumentsFromQueryParams(
  request: Request,
): { document: string; encrypted?: boolean }[] {
  const url = new URL(request.url);
  const documentParams = url.searchParams.getAll("documents");

  const documents: { document: string; encrypted?: boolean }[] = [];

  for (const param of documentParams) {
    // Handle both single IDs and comma-separated lists
    const ids = param
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    for (const id of ids) {
      // Check if the document has an ":encrypted" suffix
      if (id.endsWith(":encrypted")) {
        const documentName = id.slice(0, -10); // Remove ':encrypted' suffix
        if (documentName.length > 0) {
          documents.push({ document: documentName, encrypted: true });
        }
      } else {
        documents.push({ document: id, encrypted: false });
      }
    }
  }

  // Remove duplicates based on document name (keep the one with encryption preference)
  const uniqueDocuments = new Map<
    string,
    { document: string; encrypted?: boolean }
  >();
  for (const doc of documents) {
    const existing = uniqueDocuments.get(doc.document);
    // If document already exists, prefer the encrypted version
    if (!existing || (doc.encrypted && !existing.encrypted)) {
      uniqueDocuments.set(doc.document, doc);
    }
  }

  return Array.from(uniqueDocuments.values());
}

export function getSSEHandler<Context extends ServerContext>({
  server,
  validateRequest,
  observer,
  getDocumentsToSubscribe = getDocumentsFromQueryParams,
}: {
  server: Server<Context>;
  validateRequest: (request: Request) => Promise<Omit<Context, "clientId">>;
  /**
   * Allows you to add document subscriptions to the client. While already streaming the response
   */
  observer?: Observable<{
    /**
     * Subscribe to a document, by name, and optionally indicate if it is encrypted
     * @returns the document id
     */
    subscribe: (document: string, encrypted?: boolean) => Promise<string>;
    /**
     * Unsubscribe from a document, by id
     */
    unsubscribe: (documentId: string) => void;
  }>;
  /**
   * Callback function to extract documents to subscribe to from the request with optional encryption flag
   */
  getDocumentsToSubscribe?: (
    request: Request,
  ) => { document: string; encrypted?: boolean }[];
}) {
  return async (req: Request): Promise<Response> => {
    const context = {
      clientId: req.headers.get("x-teleportal-client-id") ?? uuidv4(),
      ...(await validateRequest(req)),
    } as Context;

    const sseTransport = compose(
      getPubSubSource({ context, pubsub: server.pubsub }),
      getSSESink({ context }),
    );

    const client = await server.createClient({
      transport: sseTransport,
      id: context.clientId,
    });

    client.addListeners({
      "document-added": async (doc) => {
        console.log("document-added", doc.id);
        await sseTransport.subscribe(doc.id);
      },
      "document-removed": async (doc) => {
        console.log("document-removed", doc.id);
        await sseTransport.unsubscribe(doc.id);
      },
      destroy: async () => {
        await sseTransport.unsubscribe();
      },
    });

    observer?.addListeners({
      subscribe: async (document, encrypted = false) => {
        const doc = await server.getOrCreateDocument({
          document,
          context,
          encrypted,
        });

        client.subscribeToDocument(doc);

        return doc.id;
      },
      unsubscribe: (documentId) => {
        const document = server.getDocument(documentId);
        if (!document) {
          throw new Error(`Document ${documentId} not loaded`);
        }
        client.unsubscribeFromDocument(document);
      },
    });

    // Use the getDocumentsToSubscribe callback if provided
    if (getDocumentsToSubscribe) {
      const subscribeToDocuments = getDocumentsToSubscribe(req);
      console.log("subscribeToDocuments", subscribeToDocuments);

      for (const { document, encrypted = false } of subscribeToDocuments) {
        const doc = await server.getOrCreateDocument({
          document,
          context,
          encrypted,
        });
        client.subscribeToDocument(doc);
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
      clientId: req.headers.get("x-teleportal-client-id") ?? uuidv4(),
      ...(await validateRequest(req)),
    } as Context;

    const fanOutWriter = createFanOutWriter<Message>();

    const httpTransport = compose(getHTTPSource({ context }), fanOutWriter);
    const responseStream = httpTransport
      .getReader()
      .readable.pipeThrough(toMessageArrayStream());

    httpTransport.getReader().readable.pipeTo(
      getPubSubSink({
        pubsub: server.pubsub,
        topicResolver: (message) => Document.getDocumentId(message),
      }).writable,
    );

    const client = await server.createClient({
      transport: httpTransport,
      id: context.clientId,
    });

    client.once("destroy", async () => {
      // close the transform stream to signal the client that the request is complete
      await fanOutWriter.writable.close();
    });

    await httpTransport.handleHTTPRequest(req);

    req.signal.addEventListener("abort", async () => {
      // transform.writable.abort();
      await fanOutWriter.writable.abort();
    });

    return new Response(responseStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "x-teleportal-client-id": context.clientId,
        "x-powered-by": "teleportal",
      },
    });
  };
}

export function decodeHTTPRequest(
  response: Response,
): ReadableStream<RawReceivedMessage> {
  return response.body!.pipeThrough(
    fromMessageArrayStream({
      clientId: response.headers.get("x-teleportal-client-id")!,
    }),
  );
}
