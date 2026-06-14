import type {
  EncryptedMessageId,
  EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import {
  decodeContentMap,
  encodeContentMap,
  mergeContentMaps,
} from "teleportal/attribution";
import {
  EncryptedDocumentMetadata,
  EncryptedDocumentStorage,
} from "../encrypted";
import type { EncodedContentMap } from "../types";

export class EncryptedMemoryStorage extends EncryptedDocumentStorage {
  public static attributionMaps = new Map<string, EncodedContentMap[]>();
  constructor(
    private options: {
      write: (
        key: string,
        doc: {
          metadata: EncryptedDocumentMetadata;
          updates: Map<EncryptedMessageId, EncryptedUpdatePayload>;
        },
      ) => Promise<void>;
      fetch: (key: string) => Promise<
        | {
            metadata: EncryptedDocumentMetadata;
            updates: Map<EncryptedMessageId, EncryptedUpdatePayload>;
          }
        | undefined
      >;
    } = {
      write: async (key, doc) => {
        EncryptedMemoryStorage.docs.set(key, doc);
      },
      fetch: async (key) => {
        return EncryptedMemoryStorage.docs.get(key);
      },
    },
  ) {
    super();
  }
  public static docs = new Map<
    string,
    {
      metadata: EncryptedDocumentMetadata;
      updates: Map<EncryptedMessageId, EncryptedUpdatePayload>;
    }
  >();

  async writeDocumentMetadata(
    key: string,
    metadata: EncryptedDocumentMetadata,
  ): Promise<void> {
    const existing = await this.options.fetch(key);
    await this.options.write(key, {
      metadata,
      updates: existing?.updates ?? new Map(),
    });
  }

  async getDocumentMetadata(key: string): Promise<EncryptedDocumentMetadata> {
    const now = Date.now();
    const doc = await this.options.fetch(key);
    if (!doc) {
      return {
        createdAt: now,
        updatedAt: now,
        encrypted: true,
        seenMessages: {},
      };
    }
    const m = doc.metadata;
    return {
      ...m,
      createdAt: typeof m.createdAt === "number" ? m.createdAt : now,
      updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : now,
      encrypted: typeof m.encrypted === "boolean" ? m.encrypted : true,
    };
  }

  async storeEncryptedMessage(
    key: string,
    messageId: EncryptedMessageId,
    payload: EncryptedUpdatePayload,
  ): Promise<void> {
    const now = Date.now();
    const existing = await this.options.fetch(key);
    const updates = existing?.updates ?? new Map();
    updates.set(messageId, payload);
    await this.options.write(key, {
      metadata:
        existing?.metadata ??
        ({
          createdAt: now,
          updatedAt: now,
          encrypted: true,
          seenMessages: {},
        } satisfies EncryptedDocumentMetadata),
      updates,
    });
  }

  async fetchEncryptedMessage(
    key: string,
    messageId: EncryptedMessageId,
  ): Promise<EncryptedUpdatePayload | null> {
    const doc = await this.options.fetch(key);
    if (!doc) {
      return null;
    }
    const update = doc.updates.get(messageId);
    if (!update) {
      return null;
    }
    return update;
  }

  override async handleUpdate(
    key: string,
    update: EncryptedUpdatePayload,
    attribution?: EncodedContentMap,
  ): Promise<void> {
    await super.handleUpdate(key, update);
    if (attribution) {
      let list = EncryptedMemoryStorage.attributionMaps.get(key);
      if (!list) {
        list = [];
        EncryptedMemoryStorage.attributionMaps.set(key, list);
      }
      list.push(attribution);
    }
  }

  async deleteDocument(key: string): Promise<void> {
    EncryptedMemoryStorage.docs.delete(key);
    EncryptedMemoryStorage.attributionMaps.delete(key);
  }

  async retrieveAttribution(
    documentId: string,
  ): Promise<EncodedContentMap | null> {
    const list = EncryptedMemoryStorage.attributionMaps.get(documentId);
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const merged = mergeContentMaps(list.map((m) => decodeContentMap(m)));
    return encodeContentMap(merged) as EncodedContentMap;
  }
}
