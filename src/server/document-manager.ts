import {
  Observable,
  type PubSub,
  type Message,
  type ServerContext,
} from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import { Document } from "./document";
import type { Logger } from "./logger";

export type DocumentManagerOptions<Context extends ServerContext> = {
  logger: Logger;
  getStorage: (ctx: {
    document: string;
    documentId: string;
    context: Context;
    encrypted: boolean;
  }) => Promise<DocumentStorage>;
  pubSub: PubSub;
  cleanupDelay?: number;
};

/**
 * The DocumentManager is responsible for creating, destroying, and managing documents.
 *
 * It holds all open documents in memory, and provides a way to get or create documents.
 */
export class DocumentManager<Context extends ServerContext> extends Observable<{
  "document-created": (document: Document<Context>) => void;
  "document-destroyed": (document: Document<Context>) => void;
}> {
  private documents = new Map<string, Document<Context>>();
  private cleanupTimeouts = new Map<string, NodeJS.Timeout>();
  private logger: Logger;
  private options: DocumentManagerOptions<Context>;

  constructor(options: DocumentManagerOptions<Context>) {
    super();
    this.options = options;
    this.logger = options.logger
      .child()
      .withContext({ name: "document-manager" });
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
      logger: this.logger.child(),
      storage: storage,
      pubSub: this.options.pubSub,
    });

    doc.on("destroy", (document) => {
      this.removeDocument(document.id);
    });

    doc.on("client-disconnected", () => {
      if (doc.getClientCount() === 0) {
        this.scheduleDocumentCleanup(doc);
      }
    });

    doc.on("client-connected", () => {
      this.cancelDocumentCleanup(doc.id);
    });

    this.documents.set(documentId, doc);
    this.logger.withMetadata({ documentId }).trace("document created");

    await this.call("document-created", doc);

    return doc;
  }

  /**
   * Schedule cleanup for a document after the cleanup delay
   */
  private scheduleDocumentCleanup(document: Document<Context>): void {
    // Cancel any existing cleanup timeout
    this.cancelDocumentCleanup(document.id);

    this.logger
      .withMetadata({
        documentId: document.id,
        cleanupDelay: this.options.cleanupDelay,
      })
      .trace("scheduling document cleanup");

    const timeout = setTimeout(() => {
      // Double-check that no clients have reconnected
      if (document.getClientCount() === 0) {
        this.logger
          .withMetadata({ documentId: document.id })
          .trace("executing document cleanup after delay");
        this.removeDocument(document.id);
      } else {
        this.logger
          .withMetadata({
            documentId: document.id,
            clientCount: document.getClientCount(),
          })
          .trace("cancelling document cleanup - clients reconnected");
      }
    }, this.options.cleanupDelay ?? 5000);

    this.cleanupTimeouts.set(document.id, timeout);
  }

  /**
   * Cancel cleanup for a document
   */
  private cancelDocumentCleanup(documentId: string): void {
    const timeout = this.cleanupTimeouts.get(documentId);
    if (timeout) {
      clearTimeout(timeout);
      this.cleanupTimeouts.delete(documentId);
      this.logger
        .withMetadata({ documentId })
        .trace("cancelled document cleanup");
    }
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

    // Cancel any pending cleanup timeout
    this.cancelDocumentCleanup(documentId);

    try {
      await document.destroy();
    } catch (e) {
      this.logger
        .withError(e)
        .withMetadata({ documentId })
        .error("Failed to destroy document");
    }

    this.documents.delete(documentId);
    this.logger
      .withMetadata({ documentId })
      .trace("document removed from manager");

    try {
      await this.call("document-destroyed", document);
    } catch (e) {
      this.logger
        .withError(e)
        .withMetadata({ documentId })
        .error("Failed to emit document-destroyed event");
    }
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
    this.logger.trace("destroying document manager");

    // Clear all cleanup timeouts
    for (const [documentId, timeout] of this.cleanupTimeouts) {
      clearTimeout(timeout);
      this.logger
        .withMetadata({ documentId })
        .trace("cleared cleanup timeout during destroy");
    }
    this.cleanupTimeouts.clear();

    // Destroy all documents with error handling
    const destroyPromises = Array.from(this.documents.values()).map(
      async (document) => {
        try {
          await this.removeDocument(document.id);
        } catch (e) {
          this.logger
            .withError(e)
            .withMetadata({ documentId: document.id })
            .error("Failed to remove document during destroy");
        }
      },
    );

    await Promise.allSettled(destroyPromises);
    this.documents.clear();

    this.logger.trace("document manager destroyed");
    super.destroy();
  }
}
