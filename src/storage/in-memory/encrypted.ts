import type {
  EncryptedMessageId,
  EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import {
  EncryptedDocumentMetadata,
  EncryptedDocumentStorage,
} from "../encrypted";
import { FileStorage } from "../file-storage";

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
      fetch: (key: string) => Promise<{
        metadata: EncryptedDocumentMetadata;
        updates: Map<EncryptedMessageId, EncryptedUpdatePayload>;
      }>;
    } = {
      write: async (key, doc) => {
        EncryptedMemoryStorage.docs.set(key, doc);
      },
      fetch: async (key) => {
        return EncryptedMemoryStorage.docs.get(key)!;
      },
    },
    public readonly fileStorage: FileStorage | undefined = undefined,
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
    let doc = await this.options.fetch(key);
    if (!doc) {
      doc = {
        metadata,
        updates: new Map(),
      };
    } else {
      doc.metadata = metadata;
    }
    await this.options.write(key, doc);
  }

  async fetchDocumentMetadata(key: string): Promise<EncryptedDocumentMetadata> {
    const doc = await this.options.fetch(key);
    if (!doc) {
      return {
        seenMessages: {},
      };
    }
    return doc.metadata;
  }

  async storeEncryptedMessage(
    key: string,
    messageId: EncryptedMessageId,
    payload: EncryptedUpdatePayload,
  ): Promise<void> {
    let doc = await this.options.fetch(key);
    if (!doc) {
      doc = {
        metadata: { seenMessages: {} },
        updates: new Map(),
      };
    }
    doc.updates.set(messageId, payload);
    await this.options.write(key, doc);
  }

  async fetchEncryptedMessage(
    key: string,
    messageId: EncryptedMessageId,
  ): Promise<EncryptedUpdatePayload> {
    const doc = await this.options.fetch(key);
    if (!doc) {
      throw new Error("Document not found");
    }
    const update = doc.updates.get(messageId);
    if (!update) {
      throw new Error("Message not found");
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
