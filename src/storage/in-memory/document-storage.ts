import { decodeContentMap, encodeContentMap, mergeContentMaps } from "teleportal/attribution";
import type { IndexedSidecar } from "../../lib/protocol/encryption/content-cipher";
import { AbstractDocumentStorage, type DocumentState } from "../document-storage";
import type { DocumentMetadata, EncodedContentMap } from "../types";

type DocumentRecord = {
  metadata: DocumentMetadata;
  state: DocumentState | null;
};

export class MemoryDocumentStorage extends AbstractDocumentStorage {
  public static docs = new Map<string, DocumentRecord>();
  public static attributionMaps = new Map<string, EncodedContentMap[]>();

  constructor(
    // Encrypted by default; pass `false` to tag documents as plaintext.
    encrypted: boolean = true,
    private options: {
      write: (key: string, doc: DocumentRecord) => Promise<void>;
      fetch: (key: string) => Promise<DocumentRecord | undefined>;
    } = {
      write: async (key, doc) => {
        MemoryDocumentStorage.docs.set(key, doc);
      },
      fetch: async (key) => {
        return MemoryDocumentStorage.docs.get(key);
      },
    },
  ) {
    super(encrypted);
  }

  async writeDocumentMetadata(key: string, metadata: DocumentMetadata): Promise<void> {
    const existing = await this.options.fetch(key);
    await this.options.write(key, {
      metadata,
      state: existing?.state ?? null,
    });
  }

  async getDocumentMetadata(key: string): Promise<DocumentMetadata> {
    const now = Date.now();
    const doc = await this.options.fetch(key);
    if (!doc) {
      return { createdAt: now, updatedAt: now, encrypted: this.encrypted };
    }
    const m = doc.metadata;
    return {
      ...m,
      createdAt: typeof m.createdAt === "number" ? m.createdAt : now,
      updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : now,
      encrypted: typeof m.encrypted === "boolean" ? m.encrypted : this.encrypted,
    };
  }

  async getDocumentState(key: string): Promise<DocumentState | null> {
    const doc = await this.options.fetch(key);
    return doc?.state ?? null;
  }

  async replaceDocumentState(
    key: string,
    update: Uint8Array,
    sidecars: IndexedSidecar[],
  ): Promise<void> {
    const now = Date.now();
    const existing =
      (await this.options.fetch(key)) ??
      ({
        metadata: { createdAt: now, updatedAt: now, encrypted: this.encrypted },
        state: null,
      } satisfies DocumentRecord);
    await this.options.write(key, {
      ...existing,
      state: { update, sidecars },
    });
  }

  protected override async storeAttribution(
    key: string,
    attribution: EncodedContentMap,
  ): Promise<void> {
    let list = MemoryDocumentStorage.attributionMaps.get(key);
    if (!list) {
      list = [];
      MemoryDocumentStorage.attributionMaps.set(key, list);
    }
    list.push(attribution);
  }

  async deleteDocument(key: string): Promise<void> {
    MemoryDocumentStorage.docs.delete(key);
    MemoryDocumentStorage.attributionMaps.delete(key);
  }

  async retrieveAttribution(documentId: string): Promise<EncodedContentMap | null> {
    const list = MemoryDocumentStorage.attributionMaps.get(documentId);
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const merged = mergeContentMaps(list.map((m) => decodeContentMap(m)));
    return encodeContentMap(merged) as EncodedContentMap;
  }
}
