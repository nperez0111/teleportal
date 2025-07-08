import { ObservableV2 } from "lib0/observable";
import type { Message, ServerContext } from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import { Document } from "./document";
import type { Logger } from "./logger";
import type { ServerSyncTransport } from "./server-sync";

export type DocumentManagerOptions<Context extends ServerContext> = {
  logger: Logger;
  getStorage: (ctx: {
    document: string;
    documentId: string;
    context: Context;
    encrypted: boolean;
  }) => Promise<DocumentStorage>;
  syncTransport: ServerSyncTransport<Context>;
};

/**
 * The DocumentManager is responsible for creating, destroying, and managing documents.
 *
 * It holds all open documents in memory, and provides a way to get or create documents.
 */
export class DocumentManager<
  Context extends ServerContext,
> extends ObservableV2<{
  "document-created": (document: Document<Context>) => void;
  "document-destroyed": (document: Document<Context>) => void;
}> {
  private documents = new Map<string, Document<Context>>();
  private logger: Logger;
  private options: DocumentManagerOptions<Context>;
  private syncTransportWriter: WritableStreamDefaultWriter<Message<Context>>;
  private syncTransportSink = new WritableStream<Message<Context>>({
    write: async (message) => {
      const documentId = Document.getDocumentId(message);
      const document = this.getDocument(documentId);
      if (!document) {
        return;
      }

      await document.broadcast(message);
      if (
        message.type === "doc" &&
        (message.payload.type === "update" ||
          message.payload.type === "sync-step-2")
      ) {
        // TODO should we just use the message handler here?
        await document.write(message.payload.update);
      }
    },
  });

  constructor(options: DocumentManagerOptions<Context>) {
    super();
    this.options = options;
    this.logger = options.logger.withContext({ name: "document-manager" });
    this.syncTransportWriter = this.options.syncTransport.writable.getWriter();
    this.options.syncTransport.readable.pipeTo(this.syncTransportSink);
  }

  /**
   * Get a document by ID
   */
  public getDocument(documentId: string): Document<Context> | undefined {
    return this.documents.get(documentId);
  }

  /**
   * Create a new document
   */
  private async createDocument({
    document,
    context,
    encrypted,
  }: Pick<Message<Context>, "document" | "context" | "encrypted">): Promise<
    Document<Context>
  > {
    const documentId = Document.getDocumentId({ document, context });

    this.logger.withMetadata({ documentId }).trace("creating document");

    const storage = await this.options.getStorage({
      document,
      documentId,
      context,
      encrypted,
    });

    if (!storage) {
      throw new Error(`Storage not found`, {
        cause: { context, document },
      });
    }

    const doc = new Document<Context>({
      name: document,
      id: documentId,
      logger: this.logger,
      storage: storage,
    });

    doc.on("destroy", (document) => {
      this.removeDocument(document.id);
    });

    // Subscribe to this document's updates
    await this.options.syncTransport.subscribe?.(documentId);

    this.documents.set(documentId, doc);
    this.logger.withMetadata({ documentId }).trace("document created");

    this.emit("document-created", [doc]);

    doc.on("broadcast", (message) => {
      this.syncTransportWriter.write(message);
    });

    return doc;
  }

  /**
   * Get or create a document
   */
  public async getOrCreateDocument(
    message: Pick<Message<Context>, "document" | "context" | "encrypted">,
  ): Promise<Document<Context>> {
    const documentId = Document.getDocumentId(message);
    const existingDocument = this.documents.get(documentId);

    if (existingDocument) {
      return existingDocument;
    }

    return await this.createDocument(message);
  }

  /**
   * Remove a document from the manager
   */
  public async removeDocument(documentId: string): Promise<void> {
    const document = this.documents.get(documentId);
    if (!document) {
      return;
    }

    await document.destroy();

    this.documents.delete(documentId);
    this.logger
      .withMetadata({ documentId })
      .trace("document removed from manager");

    this.emit("document-destroyed", [document]);
  }

  /**
   * Get document statistics
   */
  public getStats() {
    return {
      numDocuments: this.documents.size,
      documentIds: Array.from(this.documents.keys()),
    };
  }

  public async destroy() {
    await Promise.all(
      Array.from(this.documents.values()).map((document) =>
        this.removeDocument(document.id),
      ),
    );
    this.documents.clear();

    await this.syncTransportSink.abort();
    await this.syncTransportWriter.releaseLock();
    await this.options.syncTransport.close?.();
    this.logger.trace("server sync transport closed");

    this.logger.trace("document manager destroyed");
    super.destroy();
  }
}
