import type {
  DecodedEncryptedUpdatePayload,
  EncryptedStateVector,
  EncryptedSyncStep2,
  EncryptedUpdatePayload,
  EncryptedSnapshot,
} from "teleportal/protocol/encryption";
import {
  decodeEncryptedUpdate,
  decodeFromStateVector,
  decodeFromSyncStep2,
  encodeEncryptedSnapshot,
  encodeEncryptedUpdateMessages,
  encodeToStateVector,
  encodeToSyncStep2,
} from "teleportal/protocol/encryption";
import {
  type DocumentMetadata as BaseDocumentMetadata,
  type DocumentStorage,
  type Document,
} from "../types";

export interface EncryptedDocumentMetadata extends BaseDocumentMetadata {
  activeSnapshotId?: string;
  activeSnapshotVersion?: number;
  snapshots?: string[];
}

export interface EncryptedSnapshotMetadata {
  id: string;
  parentSnapshotId?: string | null;
  createdAt: number;
  updateVersion: number;
  clientCounters: Record<number, number>;
}

export type StoredEncryptedUpdate = DecodedEncryptedUpdatePayload & {
  serverVersion: number;
};

function normalizeDocumentMetadata(
  metadata: EncryptedDocumentMetadata | null,
  now: number,
): EncryptedDocumentMetadata {
  const base = metadata ?? ({} as EncryptedDocumentMetadata);
  return {
    ...base,
    createdAt: typeof base.createdAt === "number" ? base.createdAt : now,
    updatedAt: typeof base.updatedAt === "number" ? base.updatedAt : now,
    encrypted: true,
  };
}

function normalizeSnapshotMetadata(
  metadata: EncryptedSnapshotMetadata | null,
  snapshotId: string,
  now: number,
): EncryptedSnapshotMetadata | null {
  if (!metadata) {
    return null;
  }
  return {
    id: snapshotId,
    parentSnapshotId: metadata.parentSnapshotId ?? null,
    createdAt:
      typeof metadata.createdAt === "number" ? metadata.createdAt : now,
    updateVersion:
      typeof metadata.updateVersion === "number" ? metadata.updateVersion : 0,
    clientCounters: metadata.clientCounters ?? {},
  };
}

export abstract class EncryptedDocumentStorage implements DocumentStorage {
  readonly type = "document-storage" as const;
  storageType: "encrypted" = "encrypted";

  abstract writeDocumentMetadata(
    key: string,
    metadata: EncryptedDocumentMetadata,
  ): Promise<void>;

  abstract getDocumentMetadata(key: string): Promise<EncryptedDocumentMetadata>;

  abstract storeSnapshot(
    key: string,
    snapshot: EncryptedSnapshot,
    metadata: EncryptedSnapshotMetadata,
  ): Promise<void>;

  abstract fetchSnapshot(
    key: string,
    snapshotId: string,
  ): Promise<EncryptedSnapshot | null>;

  abstract writeSnapshotMetadata(
    key: string,
    metadata: EncryptedSnapshotMetadata,
  ): Promise<void>;

  abstract getSnapshotMetadata(
    key: string,
    snapshotId: string,
  ): Promise<EncryptedSnapshotMetadata | null>;

  abstract storeUpdate(
    key: string,
    update: StoredEncryptedUpdate,
  ): Promise<void>;

  abstract fetchUpdates(
    key: string,
    snapshotId: string,
    afterVersion: number,
  ): Promise<StoredEncryptedUpdate[]>;

  async handleSyncStep1(
    key: string,
    syncStep1: EncryptedStateVector,
  ): Promise<Document> {
    const now = Date.now();
    const decodedStateVector = decodeFromStateVector(syncStep1);
    const metadata = normalizeDocumentMetadata(
      await this.getDocumentMetadata(key),
      now,
    );
    const activeSnapshotId = metadata.activeSnapshotId ?? "";
    if (!activeSnapshotId) {
      return {
        id: key,
        metadata: {
          ...metadata,
          updatedAt: now,
          activeSnapshotId: undefined,
          activeSnapshotVersion: 0,
        },
        content: {
          update: encodeToSyncStep2({ updates: [] }) as unknown as any,
          stateVector: encodeToStateVector({
            snapshotId: "",
            serverVersion: 0,
          }) as unknown as any,
        },
      };
    }

    const snapshotMeta = normalizeSnapshotMetadata(
      await this.getSnapshotMetadata(key, activeSnapshotId),
      activeSnapshotId,
      now,
    );
    const serverVersion = snapshotMeta?.updateVersion ?? 0;

    let snapshot: EncryptedSnapshot | null = null;
    let updates: StoredEncryptedUpdate[] = [];

    if (decodedStateVector.snapshotId !== activeSnapshotId) {
      snapshot = await this.fetchSnapshot(key, activeSnapshotId);
      updates = await this.fetchUpdates(key, activeSnapshotId, 0);
    } else if (decodedStateVector.serverVersion < serverVersion) {
      updates = await this.fetchUpdates(
        key,
        activeSnapshotId,
        decodedStateVector.serverVersion,
      );
    }

    return {
      id: key,
      metadata: {
        ...metadata,
        updatedAt: now,
        activeSnapshotId,
        activeSnapshotVersion: serverVersion,
      },
      content: {
        update: encodeToSyncStep2({
          snapshot: snapshot ?? undefined,
          updates,
        }) as unknown as any,
        stateVector: encodeToStateVector({
          snapshotId: activeSnapshotId,
          serverVersion,
        }) as unknown as any,
      },
    };
  }

  async handleSyncStep2(
    key: string,
    syncStep2: EncryptedSyncStep2,
  ): Promise<void> {
    await this.handleEncryptedSyncStep2(key, syncStep2);
  }

  async handleUpdate(
    key: string,
    update: EncryptedUpdatePayload,
  ): Promise<void> {
    await this.handleEncryptedUpdate(key, update);
  }

  async handleEncryptedUpdate(
    key: string,
    update: EncryptedUpdatePayload,
  ): Promise<EncryptedUpdatePayload | null> {
    return this.transaction(key, async () => {
      const decoded = decodeEncryptedUpdate(update);
      if (decoded.type === "snapshot") {
        const stored = await this.storeSnapshotMessage(key, decoded.snapshot);
        return stored ? encodeEncryptedSnapshot(stored) : null;
      }
      const storedUpdates = await this.storeUpdates(key, decoded.updates);
      return storedUpdates.length > 0
        ? encodeEncryptedUpdateMessages(storedUpdates)
        : null;
    });
  }

  async handleEncryptedSyncStep2(
    key: string,
    syncStep2: EncryptedSyncStep2,
  ): Promise<EncryptedUpdatePayload[]> {
    return this.transaction(key, async () => {
      const decoded = decodeFromSyncStep2(syncStep2);
      const payloads: EncryptedUpdatePayload[] = [];
      if (decoded.snapshot) {
        const storedSnapshot = await this.storeSnapshotMessage(
          key,
          decoded.snapshot,
        );
        if (storedSnapshot) {
          payloads.push(encodeEncryptedSnapshot(storedSnapshot));
        }
      }
      if (decoded.updates.length > 0) {
        const storedUpdates = await this.storeUpdates(key, decoded.updates);
        if (storedUpdates.length > 0) {
          payloads.push(encodeEncryptedUpdateMessages(storedUpdates));
        }
      }
      return payloads;
    });
  }

  private async storeSnapshotMessage(
    key: string,
    snapshot: EncryptedSnapshot,
  ): Promise<EncryptedSnapshot | null> {
    const now = Date.now();
    const metadata = normalizeDocumentMetadata(
      await this.getDocumentMetadata(key),
      now,
    );
    const activeSnapshotId = metadata.activeSnapshotId ?? null;

    if (activeSnapshotId === snapshot.id) {
      return snapshot;
    }

    if (activeSnapshotId) {
      const parentId = snapshot.parentSnapshotId ?? null;
      if (!parentId) {
        throw new Error("Snapshot is missing parent snapshot id");
      }
      if (parentId !== activeSnapshotId) {
        throw new Error("Snapshot parent does not match active snapshot");
      }
    }

    const snapshotMetadata: EncryptedSnapshotMetadata = {
      id: snapshot.id,
      parentSnapshotId: snapshot.parentSnapshotId ?? null,
      createdAt: now,
      updateVersion: 0,
      clientCounters: {},
    };

    await this.storeSnapshot(key, snapshot, snapshotMetadata);

    const snapshots = Array.isArray(metadata.snapshots)
      ? metadata.snapshots
      : [];
    const nextSnapshots = snapshots.includes(snapshot.id)
      ? snapshots
      : [...snapshots, snapshot.id];

    await this.writeDocumentMetadata(key, {
      ...metadata,
      updatedAt: now,
      activeSnapshotId: snapshot.id,
      activeSnapshotVersion: 0,
      snapshots: nextSnapshots,
      sizeBytes: snapshot.payload.length,
    });

    return snapshot;
  }

  private async storeUpdates(
    key: string,
    updates: DecodedEncryptedUpdatePayload[],
  ): Promise<StoredEncryptedUpdate[]> {
    const now = Date.now();
    const metadata = normalizeDocumentMetadata(
      await this.getDocumentMetadata(key),
      now,
    );
    const activeSnapshotId = metadata.activeSnapshotId;
    if (!activeSnapshotId) {
      throw new Error("Cannot store updates without an active snapshot");
    }

    const snapshotMeta = normalizeSnapshotMetadata(
      await this.getSnapshotMetadata(key, activeSnapshotId),
      activeSnapshotId,
      now,
    );
    if (!snapshotMeta) {
      throw new Error("Active snapshot metadata not found");
    }

    const storedUpdates: StoredEncryptedUpdate[] = [];
    let sizeBytes = metadata.sizeBytes ?? 0;

    for (const update of updates) {
      if (update.snapshotId !== activeSnapshotId) {
        throw new Error("Update snapshot does not match active snapshot");
      }
      const [clientId, counter] = update.timestamp;
      const lastCounter = snapshotMeta.clientCounters[clientId] ?? 0;

      if (counter <= lastCounter) {
        continue;
      }
      if (counter !== lastCounter + 1) {
        throw new Error(
          `Update counter out of order for client ${clientId}: expected ${
            lastCounter + 1
          }, got ${counter}`,
        );
      }

      const nextVersion = snapshotMeta.updateVersion + 1;
      const assignedVersion =
        typeof update.serverVersion === "number"
          ? update.serverVersion
          : nextVersion;
      if (assignedVersion !== nextVersion) {
        throw new Error(
          `Update version out of order for snapshot ${activeSnapshotId}: expected ${nextVersion}, got ${assignedVersion}`,
        );
      }

      snapshotMeta.updateVersion = assignedVersion;
      snapshotMeta.clientCounters[clientId] = counter;

      const storedUpdate: StoredEncryptedUpdate = {
        ...update,
        serverVersion: assignedVersion,
      };
      await this.storeUpdate(key, storedUpdate);
      storedUpdates.push(storedUpdate);
      sizeBytes += update.payload.length;
    }

    await this.writeSnapshotMetadata(key, snapshotMeta);
    await this.writeDocumentMetadata(key, {
      ...metadata,
      updatedAt: now,
      activeSnapshotId,
      activeSnapshotVersion: snapshotMeta.updateVersion,
      sizeBytes,
    });

    return storedUpdates;
  }

  async getDocument(key: string): Promise<Document | null> {
    const now = Date.now();
    const metadata = normalizeDocumentMetadata(
      await this.getDocumentMetadata(key),
      now,
    );
    const activeSnapshotId = metadata.activeSnapshotId ?? "";
    if (!activeSnapshotId) {
      return null;
    }
    const snapshotMeta = normalizeSnapshotMetadata(
      await this.getSnapshotMetadata(key, activeSnapshotId),
      activeSnapshotId,
      now,
    );
    const serverVersion = snapshotMeta?.updateVersion ?? 0;
    const snapshot = await this.fetchSnapshot(key, activeSnapshotId);
    const updates = await this.fetchUpdates(key, activeSnapshotId, 0);
    return {
      id: key,
      metadata: {
        ...metadata,
        updatedAt: now,
        activeSnapshotId,
        activeSnapshotVersion: serverVersion,
      },
      content: {
        update: encodeToSyncStep2({
          snapshot: snapshot ?? undefined,
          updates,
        }) as unknown as any,
        stateVector: encodeToStateVector({
          snapshotId: activeSnapshotId,
          serverVersion,
        }) as unknown as any,
      },
    };
  }

  abstract deleteDocument(key: string): Promise<void>;

  transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    return cb();
  }
}
