import { describe, it, expect, beforeEach, vi } from "bun:test";
import type {
  DocumentStorage,
  DocumentMetadata,
  Document,
  EncodedContentMap,
} from "teleportal/storage";
import type { Update } from "teleportal";
import { VirtualStorage } from "./virtual-storage";

// Mock DocumentStorage for testing
class MockDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "encrypted" | "unencrypted" = "unencrypted";
  fileStorage = undefined;
  milestoneStorage = undefined;

  public handledUpdates: Update[] = [];
  public handledAttributions: (EncodedContentMap | undefined)[] = [];
  public writtenMetadata: DocumentMetadata[] = [];
  public documents = new Map<string, Document>();
  public metadataMap = new Map<string, DocumentMetadata>();

  async handleUpdate(
    documentId: string,
    update: Update,
    attribution?: EncodedContentMap,
  ): Promise<void> {
    this.handledUpdates.push(update);
    this.handledAttributions.push(attribution);
  }

  async getDocument(documentId: string): Promise<Document | null> {
    return this.documents.get(documentId) ?? null;
  }

  async writeDocumentMetadata(documentId: string, metadata: DocumentMetadata): Promise<void> {
    this.writtenMetadata.push(metadata);
    this.metadataMap.set(documentId, metadata);
  }

  async getDocumentMetadata(documentId: string): Promise<DocumentMetadata> {
    return (
      this.metadataMap.get(documentId) ?? {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: false,
      }
    );
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.documents.delete(documentId);
    this.metadataMap.delete(documentId);
  }

  async handleSyncStep1(documentId: string, syncStep1: Uint8Array): Promise<Document> {
    return this.documents.get(documentId)!;
  }

  async handleSyncStep2(documentId: string, syncStep2: Uint8Array): Promise<void> {
    // Mock implementation
  }

  async transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T> {
    return cb();
  }
}

// A storage that supports attribution, to verify VirtualStorage delegates.
class AttributionMockStorage extends MockDocumentStorage {
  public stored = new Map<string, EncodedContentMap>();

  async retrieveAttribution(documentId: string): Promise<EncodedContentMap | null> {
    return this.stored.get(documentId) ?? null;
  }
}

describe("VirtualStorage", () => {
  let mockStorage: MockDocumentStorage;
  let virtualStorage: VirtualStorage;

  beforeEach(() => {
    mockStorage = new MockDocumentStorage();
    virtualStorage = new VirtualStorage(mockStorage, {
      batchMaxSize: 10,
      batchWaitMs: 1000,
    });
  });

  it("should buffer updates and flush on read", async () => {
    const update1 = new Uint8Array([1, 2, 3]) as Update;
    const update2 = new Uint8Array([4, 5, 6]) as Update;

    // Buffer updates
    await virtualStorage.handleUpdate("doc1", update1);
    await virtualStorage.handleUpdate("doc1", update2);

    // Updates should not be flushed yet
    expect(mockStorage.handledUpdates.length).toBe(0);

    // Read should flush
    await virtualStorage.getDocument("doc1");

    // Now updates should be flushed
    expect(mockStorage.handledUpdates.length).toBe(2);
    expect(mockStorage.handledUpdates[0]).toBe(update1);
    expect(mockStorage.handledUpdates[1]).toBe(update2);
  });

  it("should buffer metadata and flush on read", async () => {
    const metadata: DocumentMetadata = {
      createdAt: 1000,
      updatedAt: 2000,
      encrypted: false,
    };

    await virtualStorage.writeDocumentMetadata("doc1", metadata);

    expect(mockStorage.writtenMetadata.length).toBe(0);

    await virtualStorage.getDocumentMetadata("doc1");

    expect(mockStorage.writtenMetadata.length).toBe(1);
    expect(mockStorage.writtenMetadata[0]).toBe(metadata);
  });

  it("should flush on delete", async () => {
    const update = new Uint8Array([1, 2, 3]) as Update;

    await virtualStorage.handleUpdate("doc1", update);
    expect(mockStorage.handledUpdates.length).toBe(0);

    await virtualStorage.deleteDocument("doc1");

    expect(mockStorage.handledUpdates.length).toBe(1);
  });

  it("does not advertise attribution when the wrapped storage lacks it", () => {
    // The server uses the presence of retrieveAttribution to decide whether to
    // compute attribution at all; it must be falsy for non-attribution backends.
    expect(virtualStorage.retrieveAttribution).toBeUndefined();
  });

  it("delegates retrieveAttribution when the wrapped storage supports it", async () => {
    const attrStorage = new AttributionMockStorage();
    const map = new Uint8Array([9, 9]) as EncodedContentMap;
    attrStorage.stored.set("doc1", map);
    const vs = new VirtualStorage(attrStorage, {
      batchMaxSize: 10,
      batchWaitMs: 1000,
    });

    expect(typeof vs.retrieveAttribution).toBe("function");
    expect(await vs.retrieveAttribution!("doc1")).toBe(map);
    expect(await vs.retrieveAttribution!("missing")).toBeNull();
  });

  it("buffers attribution and forwards it to the underlying storage", async () => {
    const update = new Uint8Array([1, 2, 3]) as Update;
    const attribution = new Uint8Array([7, 7, 7]) as EncodedContentMap;

    // Attributed writes are batched like any other write, not bypassed.
    await virtualStorage.handleUpdate("doc1", update, attribution);
    expect(mockStorage.handledUpdates.length).toBe(0);

    await virtualStorage.getDocument("doc1");

    expect(mockStorage.handledUpdates).toEqual([update]);
    expect(mockStorage.handledAttributions).toEqual([attribution]);
  });
});
