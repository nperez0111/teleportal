import { uuidv4 } from "lib0/random";
import {
  DocMessage,
  InMemoryPubSub,
  Message,
  Observable,
  PubSub,
  ServerContext,
  Transport,
} from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import { withMessageValidator } from "teleportal/transports";
import { Client } from "./client";
import { ClientManager } from "./client-manager";
import { Document } from "./document";
import { DocumentManager } from "./document-manager";
import { logger as defaultLogger, Logger } from "./logger";

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
     * Whether the document is encrypted
     */
    encrypted: boolean;
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
  checkPermission?: (ctx: {
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
   * Optional pub/sub backend for cross-instance communication.
   * If provided, the server will use this to publish and subscribe to messages across multiple server instances.
   */
  pubSub?: PubSub;
};

/**
 * The Server class represents a server that can be used to manage clients and documents.
 *
 * It is responsible for creating, destroying, and managing clients and documents.
 */
export class Server<Context extends ServerContext> extends Observable<{
  "client-connected": (client: Client<Context>) => void;
  "client-disconnected": (client: Client<Context>) => void;
  "document-load": (document: Document<Context>) => void;
  "document-unload": (document: Document<Context>) => void;
}> {
  public logger: Logger;
  private options: ServerOptions<Context>;
  private documentManager: DocumentManager<Context>;
  private clientManager: ClientManager<Context>;
  public pubsub: PubSub;

  constructor(options: ServerOptions<Context>) {
    super();
    this.options = options;
    this.logger = (options.logger ?? defaultLogger).child().withContext({
      name: "server",
    });
    this.pubsub = options.pubSub ?? new InMemoryPubSub();

    // Initialize managers
    this.documentManager = new DocumentManager({
      logger: this.logger.child(),
      getStorage: async (ctx) => {
        return await this.options.getStorage({
          ...ctx,
          server: this,
        });
      },
      pubSub: this.pubsub,
    });

    this.documentManager.addListeners({
      "document-created": (document) => this.call("document-load", document),
      "document-destroyed": (document) =>
        this.call("document-unload", document),
    });

    this.clientManager = new ClientManager({ logger: this.logger.child() });

    this.clientManager.addListeners({
      "client-connected": (client) => this.call("client-connected", client),
      "client-disconnected": (client) =>
        this.call("client-disconnected", client),
    });
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
    if (!message.context.clientId) {
      throw new Error("Client ID not found in message context", {
        cause: { document: message.document, context: message.context },
      });
    }
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
    id: clientId = uuidv4(),
  }: {
    transport: Transport<Context>;
    id?: string;
  }): Promise<Client<Context>> {
    const existingClient = this.clientManager.getClient(clientId);
    if (existingClient) {
      this.logger.withMetadata({ clientId }).trace("client already exists");
      throw new Error("Client already exists", {
        cause: { clientId },
      });
    }

    const logger = this.logger.child().withContext({
      clientId: clientId,
    });

    logger.trace("creating client");

    const validatedTransport = withMessageValidator(transport, {
      isAuthorized: async (message, type) => {
        if (!this.options.checkPermission) {
          logger.trace("no checkPermission function provided, allowing all");
          return true;
        }
        logger.trace("checking permission");

        const hasPermission = await this.options.checkPermission({
          context: message.context,
          document: message.document,
          documentId: Document.getDocumentId(message),
          message,
          type,
        });

        if (!hasPermission) {
          logger.trace("permission denied, sending auth-message");
          await client.send(
            new DocMessage(
              message.document,
              {
                type: "auth-message",
                permission: "denied",
                reason: `Insufficient permissions to access document ${message.document}`,
              },
              message.context,
              message.encrypted,
            ),
          );
          return false;
        }

        logger.trace("permission granted");
        return true;
      },
    });

    const client = new Client({
      writable: validatedTransport.writable,
      id: clientId,
      logger: this.logger.child(),
    });

    validatedTransport.readable
      .pipeTo(
        new WritableStream({
          write: async (message) => {
            const log = logger.child().withContext({
              clientId,
              context: message.context,
              document: message.document,
              documentId: Document.getDocumentId(message),
            });

            try {
              log.trace("getting document");
              const document = await this.getOrCreateDocument(message);
              log.trace("processing message");
              await document.handleMessage(message, client);
            } catch (e) {
              log.withError(e).error("Failed to process message");
            }
          },
        }),
      )
      .finally(async () => {
        logger.trace("disconnecting client since stream is closed");
        try {
          await this.disconnectClient(clientId);
          logger.trace("client disconnected since stream is closed");
        } catch (e) {
          logger
            .withError(e)
            .error("Failed to disconnect client in finally block");
        }
      });

    this.clientManager.addClient(client);

    logger.trace("client created");

    return client;
  }

  public async disconnectClient(clientId: string) {
    this.logger.withMetadata({ clientId }).trace("disconnecting client");
    try {
      await this.clientManager.removeClient(clientId);
      this.logger.withMetadata({ clientId }).trace("client disconnected");
    } catch (e) {
      this.logger
        .withError(e)
        .withMetadata({ clientId })
        .error("Failed to disconnect client");
      throw e; // Re-throw to allow caller to handle
    }
  }

  public async destroy() {
    this.logger.trace("destroying server");

    try {
      await this.documentManager.destroy();
      this.logger.trace("document manager destroyed");
    } catch (e) {
      this.logger.withError(e).error("Failed to destroy document manager");
    }

    try {
      await this.clientManager.destroy();
      this.logger.trace("client manager destroyed");
    } catch (e) {
      this.logger.withError(e).error("Failed to destroy client manager");
    }

    try {
      await this.pubsub[Symbol.asyncDispose]?.();
      this.logger.trace("pubsub destroyed");
    } catch (e) {
      this.logger.withError(e).error("Failed to destroy pubsub");
    }

    super.destroy();
    this.logger.trace("server destroyed");
  }
}
