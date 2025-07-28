import {
  EncryptedMessageId,
  EncryptedUpdate,
} from "../../encryption-state-vector/encoding";
import { DocumentMetadata, EncryptedDocumentStorage } from "../encrypted";

export class EncryptedMemoryStorage extends EncryptedDocumentStorage {
  constructor(
    private options: {
      write: (
        key: string,
        doc: {
          metadata: DocumentMetadata;
          updates: Map<EncryptedMessageId, EncryptedUpdate>;
        },
      ) => Promise<void>;
      fetch: (key: string) => Promise<{
        metadata: DocumentMetadata;
        updates: Map<EncryptedMessageId, EncryptedUpdate>;
      }>;
    } = {
      write: async (key, doc) => {
        EncryptedMemoryStorage.docs.set(key, doc);
      },
      fetch: async (key) => {
        return EncryptedMemoryStorage.docs.get(key)!;
      },
    },
  ) {
    super();
  }
  public static docs = new Map<
    string,
    {
      metadata: DocumentMetadata;
      updates: Map<EncryptedMessageId, EncryptedUpdate>;
    }
  >();

  async writeDocumentMetadata(
    key: string,
    metadata: DocumentMetadata,
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

  async fetchDocumentMetadata(key: string): Promise<DocumentMetadata> {
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
    payload: EncryptedUpdate,
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
  ): Promise<EncryptedUpdate> {
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
}
