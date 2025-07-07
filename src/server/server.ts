import { ObservableV2 } from "lib0/observable";
import { uuidv4 } from "lib0/random";
import {
  fromBinaryTransport,
  Message,
  ServerContext,
  YBinaryTransport,
} from "teleportal";
import { withMessageValidator } from "teleportal/transports";
import { Client } from "./client";
import { ClientManager } from "./client-manager";
import { Document } from "./document";
import { DocumentManager } from "./document-manager";
import { logger as defaultLogger, Logger } from "./logger";
import { MessageHandler } from "./message-handler";

import type { DocumentStorage } from "teleportal/storage";
import type { ServerSyncTransport } from "./server-sync";

export type ServerOptions<Context extends ServerContext> = {
  logger?: Logger;

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
  }) => Promise<DocumentStorage>;

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
     * The message that is being sent.
     */
    message: Message<Context>;
    /**
     * The type of the message.
     */
    type: "read" | "write";
  }) => Promise<boolean>;

  /**
   * Optional server synchronization transport for cross-instance communication.
   * If provided, the server will use this to synchronize updates across multiple server instances.
   */
  syncTransport?: ServerSyncTransport<Context>;
};

/**
 * The Server class represents a server that can be used to manage clients and documents.
 *
 * It is responsible for creating, destroying, and managing clients and documents.
 */
export class Server<Context extends ServerContext> extends ObservableV2<{
  "client-connected": (client: Client<Context>) => {};
  "client-disconnected": (client: Client<Context>) => {};
  "document-load": (document: Document<Context>) => {};
  "document-unload": (document: Document<Context>) => {};
}> {
  public logger: Logger;
  private options: ServerOptions<Context>;
  private documentManager: DocumentManager<Context>;
  private clientManager: ClientManager<Context>;
  private messageHandler: MessageHandler<Context>;

  constructor(options: ServerOptions<Context>) {
    super();
    this.options = options;
    this.logger = (options.logger ?? defaultLogger).withContext({
      name: "server",
    });

    // Initialize managers
    this.documentManager = new DocumentManager({
      logger: this.logger,
      getStorage: async (ctx) => {
        return await this.options.getStorage({
          ...ctx,
          server: this,
        });
      },
      syncTransport: this.options.syncTransport,
    });

    this.documentManager.on("document-created", (document) =>
      this.emit("document-load", [document]),
    );
    this.documentManager.on("document-destroyed", (document) =>
      this.emit("document-unload", [document]),
    );

    this.messageHandler = new MessageHandler({
      logger: this.logger,
      checkPermission: this.options.checkPermission,
    });

    this.clientManager = new ClientManager({ logger: this.logger });

    this.clientManager.on("client-connected", (client) =>
      this.emit("client-connected", [client]),
    );
    this.clientManager.on("client-disconnected", (client) =>
      this.emit("client-disconnected", [client]),
    );
  }

  #clock = 0;

  public getStats() {
    const clientStats = this.clientManager.getStats();
    const documentStats = this.documentManager.getStats();

    return {
      timestamp: new Date().toISOString(),
      clock: this.#clock++,
      numClients: clientStats.numClients,
      numDocuments: documentStats.numDocuments,
      clientIds: clientStats.clientIds,
      documentIds: documentStats.documentIds,
    };
  }

  public getDocument(documentId: string): Document<Context> | undefined {
    return this.documentManager.getDocument(documentId);
  }

  public async getOrCreateDocument(
    message: Pick<Message<Context>, "document" | "context" | "encrypted">,
  ): Promise<Document<Context>> {
    const client = this.clientManager.getClient(message.context.clientId);
    if (!client) {
      throw new Error("Client not found", {
        cause: { clientId: message.context.clientId },
      });
    }

    const document = await this.documentManager.getOrCreateDocument(message);

    // Subscribe client to document
    client.subscribeToDocument(document);

    return document;
  }

  /**
   * Create a new client on the server.
   */
  public async createClient({
    transport,
    context,
    clientId = uuidv4(),
  }: {
    transport: YBinaryTransport;
    context: Omit<Context, "clientId">;
    clientId?: string;
  }): Promise<Server<Context>> {
    this.logger
      .withMetadata({
        clientId,
        context: {
          room: context.room,
          userId: context.userId,
        },
      })
      .trace("creating client");

    const validatedTransport = withMessageValidator(
      fromBinaryTransport(
        transport,
        Object.assign({ clientId }, context) as Context,
      ),
      {
        isAuthorized: this.messageHandler.checkAuthorization.bind(
          this.messageHandler,
          clientId,
        ),
      },
    );

    const client = new Client({
      writable: validatedTransport.writable,
      id: clientId,
      logger: this.logger,
    });

    validatedTransport.readable
      .pipeTo(
        new WritableStream({
          write: async (message) => {
            const logger = this.logger.withContext({
              clientId,
              context: message.context,
              document: message.document,
              documentId: Document.getDocumentId(message),
            });

            try {
              logger.trace("getting document");
              const document = await this.getOrCreateDocument(message);
              logger.trace("processing message");
              await this.messageHandler.handleMessage(
                message,
                document,
                client,
              );
            } catch (e) {
              logger.withError(e).error("Failed to process message");
            }
          },
        }),
      )
      .finally(async () => {
        this.logger
          .withMetadata({
            clientId,
            context: {
              room: context.room,
              userId: context.userId,
            },
          })
          .trace("client disconnected");
        await this.disconnectClient(clientId);
      });

    this.clientManager.addClient(client);

    this.logger
      .withMetadata({
        clientId,
        context: {
          room: context.room,
          userId: context.userId,
        },
      })
      .trace("client created");

    await client.ready;

    this.logger
      .withMetadata({
        clientId,
        context: {
          room: context.room,
          userId: context.userId,
        },
      })
      .trace("client ready");

    return this;
  }

  public async disconnectClient(clientId: string) {
    await this.clientManager.removeClient(clientId);
  }

  public async destroy() {
    await this.documentManager.destroy();
    await this.clientManager.destroy();
  }
}
