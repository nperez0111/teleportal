import { serve } from "crossws/server";
import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";
import { AbstractDocumentStorage, type DocumentState, DocumentMetadata } from "teleportal/storage";
import type { IndexedSidecar } from "teleportal/protocol/encryption";
import { getWebsocketHandlers } from "teleportal/websocket-server";

// A custom document storage implementation, this is just for illustration purposes,
// it stores the merged V2 update + sidecars in memory.
class CustomDocumentStorage extends AbstractDocumentStorage {
  private stateMap = new Map<string, DocumentState>();
  private metadataMap = new Map<string, DocumentMetadata>();

  async getDocumentState(key: string): Promise<DocumentState | null> {
    return this.stateMap.get(key) ?? null;
  }

  async replaceDocumentState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    this.stateMap.set(key, { update, sidecars });
  }

  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
    this.metadataMap.set(key, metadata);
  }

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    return (
      this.metadataMap.get(key) ?? {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: false,
      }
    );
  }

  async deleteDocument(key: string): Promise<void> {
    this.stateMap.delete(key);
    this.metadataMap.delete(key);
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
