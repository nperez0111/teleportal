import type {
  EncryptedMessageId,
  EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import {
  EncryptedDocumentMetadata,
  EncryptedDocumentStorage,
} from "../encrypted";
import type { FileStorage } from "../types";

export class EncryptedMemoryStorage extends EncryptedDocumentStorage {
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
    fileStorage: FileStorage | undefined = undefined,
  ) {
    super();
    this.fileStorage = fileStorage;
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

  async deleteDocument(key: string): Promise<void> {
    if (this.fileStorage) {
      await this.fileStorage.deleteFilesByDocument(key);
    }
    EncryptedMemoryStorage.docs.delete(key);
  }
}
