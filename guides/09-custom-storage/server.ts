import { serve } from "crossws/server";
import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";
import {
  AbstractDocumentStorage,
  type DocumentState,
  type PendingUpdate,
  DocumentMetadata,
} from "teleportal/storage";
import type { IndexedSidecar } from "teleportal/protocol/encryption";
import { getWebsocketHandlers } from "teleportal/websocket-server";

// A custom document storage implementation, this is just for illustration purposes,
// it stores the base state + pending update log in memory.
class CustomDocumentStorage extends AbstractDocumentStorage {
  private baseMap = new Map<string, DocumentState>();
  private pendingMap = new Map<string, PendingUpdate[]>();
  private metadataMap = new Map<string, DocumentMetadata>();

  async appendUpdate(key: string, entry: PendingUpdate): Promise<void> {
    const list = this.pendingMap.get(key) ?? [];
    list.push(entry);
    this.pendingMap.set(key, list);
  }

  async getPendingUpdates(key: string): Promise<{ updates: PendingUpdate[]; cursor: number }> {
    const list = this.pendingMap.get(key) ?? [];
    return { updates: [...list], cursor: list.length };
  }

  async clearPendingUpdates(key: string, upToCursor: number): Promise<void> {
    const list = this.pendingMap.get(key);
    if (!list) return;
    if (upToCursor >= list.length) {
      this.pendingMap.delete(key);
    } else {
      list.splice(0, upToCursor);
    }
  }

  async getBaseState(key: string): Promise<DocumentState | null> {
    return this.baseMap.get(key) ?? null;
  }

  async replaceBaseState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    this.baseMap.set(key, { update, sidecars });
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
    this.baseMap.delete(key);
    this.pendingMap.delete(key);
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
