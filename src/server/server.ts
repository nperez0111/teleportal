import {
  DocMessage,
  Message,
  Observable,
  ServerContext,
  Transport,
} from "teleportal";
import { withMessageValidator } from "teleportal/transports";
import { Client } from "./client";
import { ClientManager } from "./client-manager";
import { Document } from "./document";
import { DocumentManager } from "./document-manager";
import { logger as defaultLogger, Logger } from "./logger";

import type { DocumentStorage } from "teleportal/storage";
import {
  createNoopServerSyncTransport,
  ServerSyncTransport,
} from "./server-sync";

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

  constructor(options: ServerOptions<Context>) {
    super();
    this.options = options;
    this.logger = (options.logger ?? defaultLogger).withContext({
      name: "server",
    });

    // Initialize managers
    this.documentManager = new DocumentManager({
      logger: this.logger.child(),
      getStorage: async (ctx) => {
        return await this.options.getStorage({
          ...ctx,
          server: this,
        });
      },
      syncTransport:
        this.options.syncTransport ?? createNoopServerSyncTransport(),
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
    id: clientId,
  }: {
    transport: Transport<Context>;
    id: string;
  }): Promise<Client<Context>> {
    const logger = this.logger.withContext({
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
              await document.handleMessage(message, client);
            } catch (e) {
              console.error(e);
              logger.withError(e).error("Failed to process message");
            }
          },
        }),
      )
      .finally(async () => {
        logger.trace("client disconnected");
        await this.disconnectClient(clientId);
      });

    this.clientManager.addClient(client);

    logger.trace("client created");

    return client;
  }

  public async disconnectClient(clientId: string) {
    await this.clientManager.removeClient(clientId);
  }

  public async destroy() {
    await this.documentManager.destroy();
    await this.clientManager.destroy();
  }
}
