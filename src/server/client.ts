import type {
  Message,
  RawReceivedMessage,
  ServerContext,
  YBinaryTransport,
  YSink,
} from "../lib";
import { getMessageReader } from "../lib";
import { getDocumentId, type Document } from "./document";
import { logger } from "./logger";
import type { Server } from "./server";

export type ClientHooks<Context extends ServerContext> = {
  onSubscribeToDocument?: (document: Document<Context>) => Promise<void> | void;
  onUnsubscribeFromDocument?: (
    document: Document<Context>,
  ) => Promise<void> | void;
  onMessage?: <Direction extends "inbound" | "outbound">(
    message: Direction extends "inbound" ? RawReceivedMessage : Message,
    origin: Direction extends "inbound"
      ? Client<Context>
      : Document<Context> | Client<Context>,
    direction: Direction,
  ) => Promise<void> | void;
  onClose?: () => Promise<void> | void;
};

export class Client<Context extends ServerContext> {
  public readonly id: string;
  public readonly context: Context;
  private readonly documents: Set<string> = new Set();
  private readonly hooks: ClientHooks<Context> = {};
  private readonly transport: YBinaryTransport;
  private readonly server: Server<Context>;
  private readonly sink: YSink<Context, {}>;
  public isComplete: boolean = false;

  constructor({
    id,
    hooks,
    transport,
    server,
    context,
  }: {
    id: string;
    hooks: ClientHooks<Context>;
    transport: YBinaryTransport;
    server: Server<Context>;
    context: Context;
  }) {
    this.id = id;
    this.hooks = hooks;
    this.server = server;
    this.context = context;
    // I'm not sure where the line should be drawn between the transport and the sink
    // And whether it is the server that should be responsible for the sink or the client
    this.transport = transport;
    this.sink = {
      writable: new WritableStream({
        write: async (message) => {
          logger.trace(
            {
              clientId: this.id,
              messageId: message.id,
              documentId: getDocumentId(message.document, message.context),
            },
            "client received message",
          );
          await this.hooks.onMessage?.(message, this, "inbound");

          const documentId = getDocumentId(message.document, message.context);
          const hasPermission = await this.server.options.checkPermission({
            context: message.context,
            document: message.document,
            documentId,
            client: this,
            message,
          });

          if (!hasPermission) {
            throw new Error(
              `Client ${this.id} does not have permission to access document ${documentId}`,
            );
          }

          logger.trace(
            {
              clientId: this.id,
              documentId,
            },
            "client has been authorized",
          );
          const doc = await this.server.getOrCreateDocument(
            message.document,
            message.context,
          );

          await this.subscribeToDocument(documentId);

          logger.trace(
            {
              clientId: this.id,
              documentId,
            },
            "client writing message to document",
          );

          await doc.write(message);

          logger.trace(
            {
              clientId: this.id,
              documentId,
            },
            "client wrote message to document",
          );
        },
        close: this.destroy.bind(this),
        abort: this.destroy.bind(this),
      }),
    };

    logger.trace({ clientId: this.id }, "client set up");
    // Immediately start listening for messages
    this.transport.readable
      .pipeThrough(getMessageReader(this.context))
      .pipeTo(this.sink.writable);
  }

  public async disconnect() {
    logger.trace({ clientId: this.id }, "client disconnecting");
    await this.sink.writable.close();
  }

  private async destroy() {
    logger.trace({ clientId: this.id }, "client destroying");
    await Promise.all(
      Array.from(this.documents).map((documentId) =>
        this.unsubscribeFromDocument(documentId),
      ),
    );
    this.documents.clear();
    await this.hooks.onClose?.();
    this.isComplete = true;
    logger.trace({ clientId: this.id }, "client destroyed");
  }

  private async subscribeToDocument(documentId: string) {
    if (this.documents.has(documentId)) {
      return;
    }
    logger.trace(
      { clientId: this.id, documentId },
      "client subscribing to document",
    );
    const document = this.server.documents.get(documentId);
    if (!document) {
      throw new Error(`Document not found to subscribe to`, {
        cause: {
          documentId,
        },
      });
    }
    document.subscribe(this.id);
    this.documents.add(documentId);
    await this.hooks.onSubscribeToDocument?.(document);
  }

  private async unsubscribeFromDocument(documentId: string) {
    if (!this.documents.has(documentId)) {
      return;
    }
    logger.trace(
      { clientId: this.id, documentId },
      "client unsubscribing from document",
    );
    const document = this.server.documents.get(documentId);
    if (!document) {
      throw new Error(`Document ${documentId} not found`);
    }
    await this.hooks.onUnsubscribeFromDocument?.(document);
    await document.unsubscribe(this.id);
    this.documents.delete(documentId);
  }

  /**
   * Send a message to the client.
   * @param message - The message to send.
   */
  async send(message: Message, origin: Document<Context> | Client<Context>) {
    if (message.context.clientId === this.id) {
      logger.trace(
        { clientId: this.id, messageId: message.id },
        "ignoring message sent by this client",
      );
      // Ignore messages sent by this client
      return;
    }
    logger.trace(
      { clientId: this.id, messageId: message.id },
      "client sending message",
    );
    await this.hooks.onMessage?.(message, origin, "outbound");

    // Do not hold lock on the writer
    const writer = this.transport.writable.getWriter();
    try {
      await writer.write(message.encoded);
    } finally {
      writer.releaseLock();
    }
    logger.trace(
      { clientId: this.id, messageId: message.id },
      "client sent message",
    );
  }
}
