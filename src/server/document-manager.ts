import type { Message, ServerContext } from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import { Document } from "./document";
import type { Logger } from "./logger";
import type { ServerSyncTransport } from "./server-sync";
import { ObservableV2 } from "lib0/observable";

export type DocumentManagerOptions<Context extends ServerContext> = {
  logger: Logger;
  getStorage: (ctx: {
    document: string;
    documentId: string;
    context: Context;
  }) => Promise<DocumentStorage>;
  syncTransport?: ServerSyncTransport<Context>;
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

  constructor(options: DocumentManagerOptions<Context>) {
    super();
    this.options = options;
    this.logger = options.logger.withContext({ name: "document-manager" });
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
    });

    if (!storage) {
      throw new Error(`Storage not found`, {
        cause: { context, document },
      });
    }

    const doc = new Document({
      name: document,
      id: documentId,
      logger: this.logger,
      storage: storage,
      syncTransport: this.options.syncTransport,
    });

    doc.on("destroy", (document) => {
      this.removeDocument(document.id);
    });

    this.documents.set(documentId, doc);
    this.logger.withMetadata({ documentId }).trace("document created");

    this.emit("document-created", [doc]);

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
    
    // Clean up sync transport
    if (this.options.syncTransport) {
      try {
        await this.options.syncTransport.close();
        this.logger.trace("server sync transport closed");
      } catch (error) {
        this.logger.withError(error).error("failed to close server sync transport");
      }
    }
    
    this.logger.trace("document manager destroyed");
    super.destroy();
  }
}
