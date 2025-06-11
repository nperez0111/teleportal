import type { ServerContext, YTransport } from "./base";
import { type Document, getDocumentKey } from "./document";
import type { ReceivedMessage } from "./protocol";
import type { Server } from "./server";

export type ClientHooks<Context extends ServerContext> = {
  onSubscribeToDocument?: (document: Document<Context>) => Promise<void> | void;
  onUnsubscribeFromDocument?: (
    document: Document<Context>,
  ) => Promise<void> | void;
  onMessage?: (
    message: ReceivedMessage<Context>,
    origin: Document<Context> | Client<Context>,
  ) => Promise<void> | void;
  onClose?: () => Promise<void> | void;
};

export class Client<
  Context extends ServerContext,
  AdditionalProperties extends Record<string, any> = Record<string, any>,
> {
  public readonly id: string;
  public readonly documents: Set<string> = new Set();
  private hooks: ClientHooks<Context> = {};
  private transport: YTransport<Context, AdditionalProperties>;
  private server: Server<Context>;

  constructor({
    id,
    hooks,
    transport,
    server,
  }: {
    id: string;
    hooks: ClientHooks<Context>;
    transport: YTransport<Context, AdditionalProperties>;
    server: Server<Context>;
  }) {
    this.id = id;
    this.hooks = hooks;
    this.transport = transport;
    this.server = server;
    this.listen();
  }

  private async listen() {
    await this.transport.readable.pipeTo(
      new WritableStream({
        write: async (message) => {
          await this.hooks.onMessage?.(message, this);
          const documentKey = getDocumentKey(message.document, message.context);
          const doc = await this.server.getOrCreateDocument(
            message.document,
            message.context,
          );

          await this.subscribeToDocument(documentKey);

          const writer = doc.writable.getWriter();
          await writer.write(message);
          writer.releaseLock();
        },
      }),
    );

    this.hooks.onClose?.();
  }

  async subscribeToDocument(documentKey: string) {
    if (this.documents.has(documentKey)) {
      return;
    }
    const document = this.server.documents.get(documentKey);
    if (!document) {
      throw new Error(`Document not found to subscribe to`, {
        cause: {
          documentKey,
        },
      });
    }
    document.clients.add(this.id);
    this.documents.add(documentKey);
    await this.hooks.onSubscribeToDocument?.(document);
  }

  async unsubscribeFromDocument(documentKey: string) {
    if (!this.documents.has(documentKey)) {
      return;
    }
    const document = this.server.documents.get(documentKey);
    if (!document) {
      throw new Error(`Document ${documentKey} not found`);
    }
    await this.hooks.onUnsubscribeFromDocument?.(document);
    document.clients.delete(this.id);
    this.documents.delete(documentKey);
    await document.checkUnload();
  }

  /**
   * Send a message to the client.
   * @param message - The message to send.
   */
  async send(
    message: ReceivedMessage<Context>,
    origin: Document<Context> | Client<Context>,
  ) {
    await this.hooks.onMessage?.(message, origin);
    const writer = this.transport.writable.getWriter();
    await writer.write(message);
    writer.releaseLock();
  }
}
