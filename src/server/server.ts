import { uuidv4 } from "lib0/random";
import {
  DocMessage,
  fromBinaryTransport,
  Message,
  ServerContext,
  YBinaryTransport,
} from "teleportal";
import { withMessageValidator } from "teleportal/transports";
import { Document } from "./document";
import { logger as defaultLogger, Logger } from "./logger";
import { Client } from "./client";
import type { DocumentStorage } from "teleportal/storage";
import { ClearTextResponder, EncryptedResponder } from "./responders";

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
};

export class Server<Context extends ServerContext> {
  private clients = new Map<string, Client<Context>>();
  public logger: Logger;
  private options: ServerOptions<Context>;

  constructor(options: ServerOptions<Context>) {
    this.options = options;
    this.logger = (options.logger ?? defaultLogger).withContext({
      name: "server",
    });
  }

  public getDocument(documentId: string): Document<Context> | undefined {
    let document: Document<Context> | undefined;

    this.clients.values().some((client) =>
      Array.from(client.documents.values()).some((d) => {
        if (d.id === documentId) {
          document = d;
          return true;
        }
        return false;
      }),
    );

    return document;
  }

  private async getOrCreateDocument(
    message: Message<Context>,
  ): Promise<Document<Context>> {
    const documentId = Document.getDocumentId(message);
    const client = this.clients.get(message.context.clientId);
    if (!client) {
      throw new Error("Client not found", {
        cause: { clientId: message.context.clientId },
      });
    }

    const existingDocument = this.getDocument(documentId);
    if (existingDocument) {
      // Just add it to this client's documents
      client.documents.add(existingDocument);
      existingDocument.clients.add(client);

      return existingDocument;
    }

    this.logger.withMetadata({ documentId }).trace("creating document");

    const storage = await this.options.getStorage({
      document: message.document,
      documentId,
      context: message.context,
      server: this,
    });

    if (!storage) {
      throw new Error(`Storage not found`, {
        cause: { context: message.context, document: message.document },
      });
    }

    const document = Document.fromMessage({
      message,
      logger: this.logger,
      // TODO maybe make this configurable?
      storage: message.encrypted
        ? new EncryptedResponder(storage)
        : new ClearTextResponder(storage),
    });

    client.documents.add(document);
    document.clients.add(client);

    this.logger
      .withMetadata({ documentId, clientId: client.id })
      .trace("document created");

    return document;
  }

  /**
   * Check if a client has permission to access a document.
   */
  private async checkAuthorization(
    clientId: string,
    message: Message<Context>,
    type: "read" | "write",
  ): Promise<boolean> {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error("Client not found?", { cause: { clientId } });
    }

    this.logger
      .withMetadata({
        clientId,
        context: message.context,
        document: message.document,
        documentId: Document.getDocumentId(message),
      })
      .trace("checking permission to read");
    const hasPermission = await this.options.checkPermission({
      context: message.context,
      document: message.document,
      documentId: Document.getDocumentId(message),
      message,
      type,
    });
    if (hasPermission) {
      this.logger
        .withMetadata({
          clientId,
          context: message.context,
          document: message.document,
          documentId: Document.getDocumentId(message),
        })
        .trace("client is authorized");
      return true;
    }

    this.logger
      .withMetadata({
        clientId,
        context: message.context,
        document: message.document,
        documentId: Document.getDocumentId(message),
      })
      .trace("client is not authorized");

    await client.send(
      new DocMessage(message.document, {
        type: "auth-message",
        permission: "denied",
        reason: `Insufficient permissions to access document ${message.document}`,
      }),
    );
    return false;
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
        isAuthorized: this.checkAuthorization.bind(this, clientId),
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
            this.logger
              .withMetadata({
                clientId,
                context: message.context,
                document: message.document,
                documentId: Document.getDocumentId(message),
              })
              .trace("writing message to storage");
            const document = await this.getOrCreateDocument(message);
            await document.write(message);
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
        this.disconnectClient(clientId);
      });

    this.clients.set(clientId, client);

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
    const client = this.clients.get(clientId);

    if (!client) {
      return;
    }
    this.logger.withMetadata({ clientId }).trace("disconnecting client");

    // Keep a reference to the subscribed documents
    const documents = client.documents;

    for (const document of documents) {
      // Remove the client from all of its open documents
      document.clients.delete(client);

      if (document.clients.size === 0) {
        // If the document has no more clients, destroy it
        this.logger
          .withMetadata({ documentId: document.id })
          .trace("destroying document - no remaining clients");
        // destroy document if no other clients are subscribed to it
        await document.destroy();
      }
    }

    await client.destroy();
    // Remove the client from the server
    this.clients.delete(clientId);
  }
}
