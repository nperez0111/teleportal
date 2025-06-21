import { uuidv4 } from "lib0/random";

import {
  encodePongMessage,
  isPingMessage,
  type Message,
  type ServerContext,
  type YBinaryTransport,
} from "../lib";
import {
  StorageAdapter,
  type DocumentStorage,
  type LowLevelDocumentStorage,
} from "../storage";
import { Client } from "./client";
import { Document, getDocumentId } from "./document";
import { logger, type Logger } from "./logger";

export type ServerOptions<Context extends ServerContext> = {
  getStorage: (ctx: {
    context: Context;
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
};

export class Server<Context extends ServerContext> {
  public readonly clients: Map<string, Client<Context>> = new Map();
  public readonly documents: Map<string, Document<Context>> = new Map();
  public readonly options: ServerOptions<Context>;
  private logger: Logger;

  constructor(options: ServerOptions<Context>) {
    this.options = options;
    this.logger = logger.child({ name: "server" });
  }

  public async getOrCreateDocument(name: string, context: Context) {
    const documentId = getDocumentId(name, context);

    if (this.documents.has(documentId)) {
      return this.documents.get(documentId)!;
    }

    this.logger.trace({ documentId }, "creating document");

    const storage = await this.options.getStorage({
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
    });

    this.documents.set(documentId, doc);

    this.logger.trace({ documentId }, "document created");

    return doc;
  }

  public async createClient(
    transport: YBinaryTransport,
    context: Omit<Context, "clientId">,
    clientId = uuidv4(),
  ) {
    this.logger.trace({ clientId }, "creating client");

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
            transform(chunk, controller) {
              // Just filter out ping messages to avoid any unnecessary processing
              if (isPingMessage(chunk)) {
                const writer = transport.writable.getWriter();
                writer.write(encodePongMessage());
                writer.releaseLock();
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
    });

    this.clients.set(clientId, client);

    this.logger.trace({ clientId }, "client created");

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
