import { serve } from "crossws/server";
import { getStateVectorFromUpdate, mergeUpdates, Update, type VersionedUpdate } from "teleportal";
import { convertToV2 } from "teleportal/protocol";
import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";
import { Document, DocumentMetadata, UnencryptedDocumentStorage } from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";

// A custom document storage implementation, this is just for illustration purposes, it only stores updates in memory and merges them on the fly.
class CustomDocumentStorage extends UnencryptedDocumentStorage {
  private docMap = new Map<Document["id"], Update[]>();
  private metadataMap = new Map<Document["id"], DocumentMetadata>();

  async handleUpdate(documentId: Document["id"], update: VersionedUpdate): Promise<void> {
    // store an update, converting to V2 for storage
    const v2 = convertToV2(update);
    this.docMap.set(documentId, [...(this.docMap.get(documentId) ?? []), v2]);
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

  async getDocumentMetadata(documentId: Document["id"]): Promise<DocumentMetadata> {
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
    fetch: async () => {
      const res = await fetch(
        "https://raw.githubusercontent.com/nperez0111/teleportal/refs/heads/main/examples/simple/index.html",
      );
      return new Response(await res.text(), {
        headers: { "Content-Type": "text/html" },
      });
    },
  }),
});
