import { uuidv4 } from "lib0/random";

import {
  encodePongMessage,
  isPingMessage,
  type Message,
  type ServerContext,
  type YBinaryTransport,
} from "teleportal";
import {
  StorageAdapter,
  type DocumentStorage,
  type LowLevelDocumentStorage,
} from "teleportal/storage";
import { Client } from "./client";
import { Document, getDocumentId } from "./document";
import { type Logger } from "./logger";

export type ServerOptions<Context extends ServerContext> = {
  getStorage: (ctx: {
    /**
     * The name of the document.
     */
    document: string;
    /**
     * The unique identifier of the document.
     */
    documentId: string;
    /**
     * The context of the server.
     */
    context: Context;
    /**
     * The server instance.
     */
    server: Server<Context>;
  }) => Promise<DocumentStorage | LowLevelDocumentStorage>;
  /**
   * Check if a client has permission to access a document.
   * @note This is called on every message sent, so it should be fast.
   * @returns True if the client has permission, false otherwise.
   */
  checkPermission: (ctx: {
    /**
     * The context of the client.
     */
    context: Context;
    /**
     * The name of the document.
     */
    document: string;
    /**
     * The unique identifier of the document.
     */
    documentId: string;
    /**
     * The client that is trying to access the document.
     */
    client: Client<Context>;
    /**
     * The message that is being sent.
     */
    message: Message<Context>;
  }) => Promise<boolean>;
  logger: Logger;
};

export class Server<Context extends ServerContext> {
  public readonly clients: Map<string, Client<Context>> = new Map();
  public readonly documents: Map<string, Document<Context>> = new Map();
  public readonly options: ServerOptions<Context>;
  public readonly logger: Logger;

  constructor(options: ServerOptions<Context>) {
    this.options = options;
    this.logger = options.logger.withContext({ name: "server" });
  }

  public async getOrCreateDocument(name: string, context: Context) {
    const documentId = getDocumentId(name, context);

    if (this.documents.has(documentId)) {
      return this.documents.get(documentId)!;
    }

    this.logger.withMetadata({ documentId }).trace("creating document");

    const storage = await this.options.getStorage({
      document: name,
      documentId,
      context,
      server: this,
    });

    if (!storage) {
      throw new Error(`Storage not found`, { cause: { context } });
    }

    const doc = new Document<Context>({
      id: documentId,
      name,
      server: this,
      hooks: {
        onUnload: () => {
          this.documents.delete(documentId);
        },
      },
      storage: StorageAdapter.fromStorage(storage),
      logger: this.logger,
    });

    this.documents.set(documentId, doc);

    this.logger.withMetadata({ documentId }).trace("document created");

    return doc;
  }

  public async createClient(
    transport: YBinaryTransport,
    context: Omit<Context, "clientId">,
    clientId = uuidv4(),
  ) {
    this.logger.withMetadata({ clientId }).trace("creating client");

    const client = new Client<Context>({
      id: clientId,
      hooks: {},
      /**
       * What is nice about this is that we can wrap the transport of a client to
       * see what actually is being read and written to the client.
       * We will also implement the binary encoding/decoding here.
       */
      transport: {
        writable: transport.writable,
        readable: transport.readable.pipeThrough(
          new TransformStream({
            async transform(chunk, controller) {
              // Just filter out ping messages to avoid any unnecessary processing
              if (isPingMessage(chunk)) {
                const writer = transport.writable.getWriter();
                try {
                  await writer.write(encodePongMessage());
                } finally {
                  writer.releaseLock();
                }
                return;
              }
              controller.enqueue(chunk);
            },
          }),
        ),
      },
      server: this,
      context: Object.assign(
        {
          clientId,
        },
        context,
      ) as Context,
      logger: this.logger,
    });

    this.clients.set(clientId, client);

    this.logger.withMetadata({ clientId }).trace("client created");

    return client;
  }

  public async disconnectClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      await client.disconnect();
      this.clients.delete(clientId);
    }
  }
}
