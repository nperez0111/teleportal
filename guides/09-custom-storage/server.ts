import { serve } from "crossws/server";
import {
  getStateVectorFromUpdate,
  mergeUpdates,
  StateVector,
  Update,
} from "teleportal";
import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";
import {
  Document,
  DocumentMetadata,
  UnencryptedDocumentStorage,
} from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";

// A custom document storage implementation, this is just for illustration purposes, it only stores updates in memory and merges them on the fly.
class CustomDocumentStorage extends UnencryptedDocumentStorage {
  private docMap = new Map<Document["id"], Update[]>();
  private metadataMap = new Map<Document["id"], DocumentMetadata>();

  async handleUpdate(
    documentId: Document["id"],
    update: Update,
  ): Promise<void> {
    // store an update
    // in this case we are just storing each update in memory and merging them on the fly
    this.docMap.set(documentId, [
      ...(this.docMap.get(documentId) ?? []),
      update,
    ]);
  }

  // This is the main method that is called when a client requests a document.
  async getDocument(documentId: Document["id"]): Promise<Document | null> {
    // get all the updates for the document
    const updates = this.docMap.get(documentId) ?? [];

    // merge them into a single update
    const update = mergeUpdates(updates);

    // derive the current state vector from that merged update
    const stateVector = getStateVectorFromUpdate(update);

    // store the merged update in memory for next time
    this.docMap.set(documentId, [update]);

    return {
      id: documentId,
      // fetch current metadata
      metadata: await this.getDocumentMetadata(documentId),
      content: {
        update,
        stateVector,
      },
    };
  }

  async writeDocumentMetadata(
    documentId: Document["id"],
    metadata: DocumentMetadata,
  ): Promise<void> {
    // store metadata
    this.metadataMap.set(documentId, metadata);
  }

  async getDocumentMetadata(
    documentId: Document["id"],
  ): Promise<DocumentMetadata> {
    // fetch metadata
    return (
      this.metadataMap.get(documentId) ?? {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: false,
      }
    );
  }

  async deleteDocument(documentId: Document["id"]): Promise<void> {
    // delete document
    this.docMap.delete(documentId);
    this.metadataMap.delete(documentId);
  }
}

const server = new Server({
  storage: new CustomDocumentStorage(),
});

serve({
  websocket: getWebsocketHandlers({
    server: server,
    onUpgrade: async () => {
      return {
        context: { userId: "nick", room: "test" },
      };
    },
  }),
  fetch: getHTTPHandlers({
    server: server,
    getContext: () => {
      return { userId: "nick", room: "test" };
    },
  }),
});
