import type { EncryptedSnapshot } from "teleportal/protocol/encryption";
import {
  EncryptedDocumentMetadata,
  EncryptedDocumentStorage,
  EncryptedSnapshotMetadata,
  StoredEncryptedUpdate,
} from "../encrypted";

type EncryptedSnapshotRecord = {
  snapshot: EncryptedSnapshot;
  metadata: EncryptedSnapshotMetadata;
  updates: StoredEncryptedUpdate[];
};

type EncryptedDocumentRecord = {
  metadata: EncryptedDocumentMetadata;
  snapshots: Map<string, EncryptedSnapshotRecord>;
};

export class EncryptedMemoryStorage extends EncryptedDocumentStorage {
  constructor(
    private options: {
      write: (key: string, doc: EncryptedDocumentRecord) => Promise<void>;
      fetch: (key: string) => Promise<EncryptedDocumentRecord | undefined>;
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
  public static docs = new Map<string, EncryptedDocumentRecord>();

  async writeDocumentMetadata(
    key: string,
    metadata: EncryptedDocumentMetadata,
  ): Promise<void> {
    const existing = await this.options.fetch(key);
    await this.options.write(key, {
      metadata,
      snapshots: existing?.snapshots ?? new Map(),
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

  async storeSnapshot(
    key: string,
    snapshot: EncryptedSnapshot,
    metadata: EncryptedSnapshotMetadata,
  ): Promise<void> {
    const now = Date.now();
    const existing =
      (await this.options.fetch(key)) ??
      ({
        metadata: {
          createdAt: now,
          updatedAt: now,
          encrypted: true,
        },
        snapshots: new Map(),
      } satisfies EncryptedDocumentRecord);
    const existingRecord = existing.snapshots.get(snapshot.id);
    existing.snapshots.set(snapshot.id, {
      snapshot,
      metadata,
      updates: existingRecord?.updates ?? [],
    });
    await this.options.write(key, existing);
  }

  async fetchSnapshot(
    key: string,
    snapshotId: string,
  ): Promise<EncryptedSnapshot | null> {
    const doc = await this.options.fetch(key);
    if (!doc) {
      return null;
    }
    const record = doc.snapshots.get(snapshotId);
    if (!record) {
      return null;
    }
    return record.snapshot;
  }

  async writeSnapshotMetadata(
    key: string,
    metadata: EncryptedSnapshotMetadata,
  ): Promise<void> {
    const doc = await this.options.fetch(key);
    if (!doc) {
      return;
    }
    const record = doc.snapshots.get(metadata.id);
    if (!record) {
      return;
    }
    record.metadata = metadata;
    await this.options.write(key, doc);
  }

  async getSnapshotMetadata(
    key: string,
    snapshotId: string,
  ): Promise<EncryptedSnapshotMetadata | null> {
    const doc = await this.options.fetch(key);
    if (!doc) {
      return null;
    }
    return doc.snapshots.get(snapshotId)?.metadata ?? null;
  }

  async storeUpdate(key: string, update: StoredEncryptedUpdate): Promise<void> {
    const now = Date.now();
    const doc =
      (await this.options.fetch(key)) ??
      ({
        metadata: {
          createdAt: now,
          updatedAt: now,
          encrypted: true,
        },
        snapshots: new Map(),
      } satisfies EncryptedDocumentRecord);
    const record = doc.snapshots.get(update.snapshotId);
    if (!record) {
      throw new Error("Snapshot not found for update");
    }
    record.updates.push(update);
    await this.options.write(key, doc);
  }

  async fetchUpdates(
    key: string,
    snapshotId: string,
    afterVersion: number,
  ): Promise<StoredEncryptedUpdate[]> {
    const doc = await this.options.fetch(key);
    if (!doc) {
      return [];
    }
    const record = doc.snapshots.get(snapshotId);
    if (!record) {
      return [];
    }
    return record.updates
      .filter((update) => update.serverVersion > afterVersion)
      .sort((a, b) => a.serverVersion - b.serverVersion);
  }

  async deleteDocument(key: string): Promise<void> {
    EncryptedMemoryStorage.docs.delete(key);
  }
}
