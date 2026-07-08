import { describe, it, expect, beforeEach } from "bun:test";
import type {
  DocumentStorage,
  DocumentMetadata,
  Document,
  EncodedContentMap,
} from "teleportal/storage";
import type { Update, VersionedUpdate, VersionedSyncStep2Update } from "teleportal";
import { VirtualStorage } from "./virtual-storage";

function versionedUpdate(bytes: Uint8Array): VersionedUpdate {
  return { version: 2, data: bytes as Update } as VersionedUpdate;
}

// Mock DocumentStorage for testing
class MockDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "encrypted" | "unencrypted" = "unencrypted";
  fileStorage = undefined;
  milestoneStorage = undefined;

  public handledUpdates: VersionedUpdate[] = [];
  public handledAttributions: (EncodedContentMap | undefined)[] = [];
  public writtenMetadata: DocumentMetadata[] = [];
  public documents = new Map<string, Document>();
  public metadataMap = new Map<string, DocumentMetadata>();

  async handleUpdate(
    documentId: string,
    update: VersionedUpdate,
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

  async handleSyncStep1(documentId: string, _syncStep1: Uint8Array): Promise<Document> {
    return this.documents.get(documentId)!;
  }

  async handleSyncStep2(_documentId: string, _syncStep2: VersionedSyncStep2Update): Promise<void> {
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
    const update1 = versionedUpdate(new Uint8Array([1, 2, 3]));
    const update2 = versionedUpdate(new Uint8Array([4, 5, 6]));

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

  it("applies each buffered update exactly once when the batch timer flushes", async () => {
    // Regression: the batch processor and the read-path flush must not both
    // apply the same buffered updates. With a tiny batch window, the timer
    // flush drains the buffer; a subsequent read must not re-apply anything.
    const vs = new VirtualStorage(mockStorage, { batchMaxSize: 100, batchWaitMs: 1 });
    const u1 = versionedUpdate(new Uint8Array([1]));
    const u2 = versionedUpdate(new Uint8Array([2]));

    await vs.handleUpdate("doc1", u1);
    await vs.handleUpdate("doc1", u2);

    // Wait for the batch timer to fire (batchWaitMs = 1).
    {
      const deadline = Date.now() + 1000;
      while (mockStorage.handledUpdates.length < 2) {
        if (Date.now() > deadline) throw new Error("timed out waiting for batch flush");
        await new Promise((r) => setTimeout(r, 1));
      }
    }

    // A read afterwards must not re-apply the already-flushed updates.
    await vs.getDocument("doc1");

    expect(mockStorage.handledUpdates).toEqual([u1, u2]);
  });

  it("applies each buffered update exactly once when batchMaxSize is reached", async () => {
    const vs = new VirtualStorage(mockStorage, { batchMaxSize: 2, batchWaitMs: 100_000 });
    const u1 = versionedUpdate(new Uint8Array([1]));
    const u2 = versionedUpdate(new Uint8Array([2]));

    // Two updates hit batchMaxSize and flush synchronously via the processor.
    await vs.handleUpdate("doc1", u1);
    await vs.handleUpdate("doc1", u2);

    {
      const deadline = Date.now() + 1000;
      while (mockStorage.handledUpdates.length < 2) {
        if (Date.now() > deadline) throw new Error("timed out waiting for size flush");
        await new Promise((r) => setTimeout(r, 1));
      }
    }

    await vs.getDocument("doc1");
    expect(mockStorage.handledUpdates).toEqual([u1, u2]);
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
    const update = versionedUpdate(new Uint8Array([1, 2, 3]));

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
    const update = versionedUpdate(new Uint8Array([1, 2, 3]));
    const attribution = new Uint8Array([7, 7, 7]) as EncodedContentMap;

    // Attributed writes are batched like any other write, not bypassed.
    await virtualStorage.handleUpdate("doc1", update, attribution);
    expect(mockStorage.handledUpdates.length).toBe(0);

    await virtualStorage.getDocument("doc1");

    expect(mockStorage.handledUpdates).toEqual([update]);
    expect(mockStorage.handledAttributions).toEqual([attribution]);
  });
});
