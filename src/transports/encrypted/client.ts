import { toBase64 } from "lib0/buffer";
import { digest } from "lib0/hash/sha256";
import { ClientContext, Observable } from "teleportal";
import {
  type DecryptedBinary,
  decryptUpdate as defaultDecryptUpdate,
  encryptUpdate as defaultEncryptUpdate,
  type EncryptedBinary,
} from "teleportal/encryption-key";
import {
  AwarenessMessage,
  AwarenessUpdateMessage,
  DocMessage,
  Message,
  Update,
} from "teleportal/protocol";
import type {
  DecodedEncryptedUpdatePayload,
  EncryptedSnapshot,
  EncryptedStateVector,
  EncryptedSyncStep2,
  EncryptedUpdatePayload,
} from "teleportal/protocol/encryption";
import {
  decodeEncryptedUpdate,
  decodeFromStateVector,
  decodeFromSyncStep2,
  encodeEncryptedSnapshot,
  encodeEncryptedUpdateMessages,
  encodeToSyncStep2,
  getEncryptedStateVector,
  LamportClock,
} from "teleportal/protocol/encryption";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness.js";
import * as Y from "yjs";
import {
  getSyncTransactionOrigin,
  YDocSinkHandler,
  YDocSourceHandler,
} from "../ydoc";

/** Default interval for periodic snapshot compaction (5 minutes). Use 0 to disable. */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

type EncryptionClientEvents = {
  "snapshot-stored": (snapshot: EncryptedSnapshot) => void;
  "update-stored": (update: DecodedEncryptedUpdatePayload) => void;
  "update-acknowledged": (update: DecodedEncryptedUpdatePayload) => void;
  "state-updated": (state: {
    snapshotId: string | null;
    serverVersion: number;
  }) => void;
  /** Emitted when the client wants to send a message (e.g. periodic compaction snapshot). */
  "send-message": (message: Message) => void;
};

export class EncryptionClient
  extends Observable<EncryptionClientEvents>
  implements YDocSinkHandler, YDocSourceHandler
{
  /**
   * A {@link LamportClock} to keep track of the message order
   */
  private clock: LamportClock;

  private activeSnapshot: EncryptedSnapshot | null = null;
  private serverVersion = 0;
  private pendingUpdates = new Map<string, DecodedEncryptedUpdatePayload>();
  private seenUpdates = new Map<string, Set<string>>();
  private queuedUpdates = new Map<string, DecodedEncryptedUpdatePayload[]>();
  private loadingPromise: Promise<void> | null = null;
  #snapshotIntervalMs: number;
  #snapshotTimer: ReturnType<typeof setInterval> | null = null;

  public document: string;
  public ydoc: Y.Doc;
  public awareness: Awareness;
  public key: CryptoKey;
  #decryptUpdate: (
    key: CryptoKey,
    encryptedUpdate: EncryptedBinary,
  ) => Promise<DecryptedBinary>;
  #encryptUpdate: (
    key: CryptoKey,
    update: DecryptedBinary,
  ) => Promise<EncryptedBinary>;

  constructor({
    document,
    ydoc,
    awareness,
    key,
    decryptUpdate,
    encryptUpdate,
    snapshotIntervalMs = DEFAULT_SNAPSHOT_INTERVAL_MS,
  }: {
    document: string;
    ydoc?: Y.Doc;
    awareness?: Awareness;
    key: CryptoKey;
    decryptUpdate?: (
      key: CryptoKey,
      encryptedUpdate: EncryptedBinary,
    ) => Promise<DecryptedBinary>;
    encryptUpdate?: (
      key: CryptoKey,
      update: DecryptedBinary,
    ) => Promise<EncryptedBinary>;
    /** Interval in ms to create a compaction snapshot. Default 5 minutes. Set to 0 to disable. */
    snapshotIntervalMs?: number;
  }) {
    super();
    this.ydoc = ydoc ?? new Y.Doc();
    this.awareness = awareness ?? new Awareness(this.ydoc);
    this.clock = new LamportClock(this.awareness.clientID);
    this.document = document;
    this.key = key;
    this.#decryptUpdate = decryptUpdate ?? defaultDecryptUpdate;
    this.#encryptUpdate = encryptUpdate ?? defaultEncryptUpdate;
    this.#snapshotIntervalMs = snapshotIntervalMs;
  }

  /**
   * Clears the periodic snapshot timer and any other resources. Call when the client is no longer used.
   */
  public destroy(): void {
    this.#clearSnapshotTimer();
  }

  #clearSnapshotTimer(): void {
    if (this.#snapshotTimer !== null) {
      clearInterval(this.#snapshotTimer);
      this.#snapshotTimer = null;
    }
  }

  #scheduleNextSnapshot(): void {
    this.#clearSnapshotTimer();
    if (this.#snapshotIntervalMs <= 0 || !this.activeSnapshotId) {
      return;
    }
    this.#snapshotTimer = setInterval(() => {
      void (async () => {
        if (!this.activeSnapshotId) return;
        const currentState = Y.encodeStateAsUpdateV2(this.ydoc);
        const snapshotState = await this.decryptUpdate(
          this.activeSnapshot!.payload,
        );
        if (
          currentState.length === snapshotState.length &&
          currentState.every((b, i) => b === snapshotState[i])
        ) {
          return;
        }
        try {
          const message = await this.createSnapshotMessage();
          this.call("send-message", message);
        } finally {
          this.#scheduleNextSnapshot();
        }
      })();
    }, this.#snapshotIntervalMs);
  }

  /**
   * Encrypts a {@link DecryptedBinary} using the {@link CryptoKey}.
   */
  public encryptUpdate(update: DecryptedBinary): Promise<EncryptedBinary> {
    return this.#encryptUpdate(this.key, update);
  }

  /**
   * Decrypts an {@link EncryptedBinary} using the {@link CryptoKey}.
   */
  public decryptUpdate(
    encryptedUpdate: EncryptedBinary,
  ): Promise<DecryptedBinary> {
    return this.#decryptUpdate(this.key, encryptedUpdate);
  }

  private get activeSnapshotId(): string | null {
    return this.activeSnapshot?.id ?? null;
  }

  private getUpdateKey(
    snapshotId: string,
    timestamp: [number, number],
  ): string {
    return `${snapshotId}:${timestamp[0]}-${timestamp[1]}`;
  }

  private markSeen(update: DecodedEncryptedUpdatePayload) {
    const snapshotId = update.snapshotId;
    const key = this.getUpdateKey(snapshotId, update.timestamp);
    if (!this.seenUpdates.has(snapshotId)) {
      this.seenUpdates.set(snapshotId, new Set());
    }
    this.seenUpdates.get(snapshotId)!.add(key);
  }

  private hasSeen(update: DecodedEncryptedUpdatePayload): boolean {
    const snapshotId = update.snapshotId;
    const key = this.getUpdateKey(snapshotId, update.timestamp);
    return this.seenUpdates.get(snapshotId)?.has(key) ?? false;
  }

  private queueUpdate(update: DecodedEncryptedUpdatePayload) {
    const list = this.queuedUpdates.get(update.snapshotId) ?? [];
    list.push(update);
    this.queuedUpdates.set(update.snapshotId, list);
  }

  private async applyUpdatesToDoc(updates: DecryptedBinary[]): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    this.ydoc.transact((tr) => {
      for (const update of updates) {
        Y.applyUpdateV2(tr.doc, update, getSyncTransactionOrigin(this.ydoc));
      }
    });
  }

  private handleAcknowledgement(update: DecodedEncryptedUpdatePayload) {
    if (typeof update.serverVersion !== "number") {
      return;
    }
    if (update.serverVersion > this.serverVersion) {
      this.serverVersion = update.serverVersion;
      this.call("state-updated", {
        snapshotId: this.activeSnapshotId,
        serverVersion: this.serverVersion,
      });
    }
    const key = this.getUpdateKey(update.snapshotId, update.timestamp);
    const pending = this.pendingUpdates.get(key);
    if (pending) {
      this.pendingUpdates.delete(key);
      this.call("update-acknowledged", {
        ...pending,
        serverVersion: update.serverVersion,
      });
    }
  }

  /** Decrypt and apply in chunks to yield to the event loop and keep UI responsive. */
  private static readonly DECRYPT_BATCH_SIZE = 100;

  private async applyUpdates(
    updates: DecodedEncryptedUpdatePayload[],
  ): Promise<void> {
    const toDecrypt: DecodedEncryptedUpdatePayload[] = [];
    for (const update of updates) {
      if (update.snapshotId !== this.activeSnapshotId) {
        this.queueUpdate(update);
        continue;
      }

      if (!this.hasSeen(update)) {
        toDecrypt.push(update);
        this.markSeen(update);
        if (!update.id) {
          update.id = toBase64(digest(update.payload));
        }
        this.call("update-stored", update);
      }
      this.handleAcknowledgement(update);
    }

    const batchSize = EncryptionClient.DECRYPT_BATCH_SIZE;
    for (let i = 0; i < toDecrypt.length; i += batchSize) {
      const batch = toDecrypt.slice(i, i + batchSize);
      const decrypted = await Promise.all(
        batch.map((update) => this.decryptUpdate(update.payload)),
      );
      await this.applyUpdatesToDoc(decrypted);
      if (i + batchSize < toDecrypt.length) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  }

  private async applyQueuedUpdates(snapshotId: string): Promise<void> {
    const queued = this.queuedUpdates.get(snapshotId);
    if (!queued || queued.length === 0) {
      return;
    }
    queued.sort((a, b) => (a.serverVersion ?? 0) - (b.serverVersion ?? 0));
    this.queuedUpdates.delete(snapshotId);
    await this.applyUpdates(queued);
  }

  private async applySnapshot(snapshot: EncryptedSnapshot): Promise<void> {
    if (this.activeSnapshot?.id === snapshot.id) {
      return;
    }
    const decrypted = await this.decryptUpdate(snapshot.payload);
    await this.applyUpdatesToDoc([decrypted]);

    this.activeSnapshot = snapshot;
    this.serverVersion = 0;
    this.clock = new LamportClock(this.awareness.clientID);
    this.pendingUpdates.clear();
    this.seenUpdates.clear();
    this.queuedUpdates.clear();

    this.call("snapshot-stored", snapshot);
    this.call("state-updated", {
      snapshotId: snapshot.id,
      serverVersion: this.serverVersion,
    });
    this.#scheduleNextSnapshot();
  }

  private async createSnapshot(): Promise<EncryptedSnapshot> {
    const snapshotId = crypto.randomUUID();
    const parentSnapshotId = this.activeSnapshotId ?? null;
    const update = Y.encodeStateAsUpdateV2(this.ydoc) as Update;
    const encryptedUpdate = await this.encryptUpdate(update);
    const snapshot: EncryptedSnapshot = {
      id: snapshotId,
      parentSnapshotId,
      payload: encryptedUpdate,
    };
    this.activeSnapshot = snapshot;
    this.serverVersion = 0;
    this.clock = new LamportClock(this.awareness.clientID);
    this.pendingUpdates.clear();
    this.seenUpdates.clear();
    this.queuedUpdates.clear();

    this.call("snapshot-stored", snapshot);
    this.call("state-updated", {
      snapshotId: snapshot.id,
      serverVersion: this.serverVersion,
    });
    this.#scheduleNextSnapshot();
    return snapshot;
  }

  private createUpdatePayload(
    payload: EncryptedBinary,
  ): DecodedEncryptedUpdatePayload {
    if (!this.activeSnapshotId) {
      throw new Error("Cannot create update without an active snapshot");
    }
    const timestamp = this.clock.tick();
    const update: DecodedEncryptedUpdatePayload = {
      id: toBase64(digest(payload)),
      snapshotId: this.activeSnapshotId,
      timestamp,
      payload,
    };
    this.markSeen(update);
    this.pendingUpdates.set(
      this.getUpdateKey(update.snapshotId, timestamp),
      update,
    );
    this.call("update-stored", update);
    return update;
  }

  public async loadState({
    snapshot,
    updates,
  }: {
    snapshot?: EncryptedSnapshot | null;
    updates?: DecodedEncryptedUpdatePayload[];
  }): Promise<void> {
    this.loadingPromise = (async () => {
      if (snapshot) {
        await this.applySnapshot(snapshot);
      }
      if (updates && updates.length > 0) {
        await this.applyUpdates(updates);
      }
    })();
    await this.loadingPromise;
    this.loadingPromise = null;
  }

  public async start(): Promise<Message> {
    if (this.loadingPromise) {
      await this.loadingPromise;
    }
    return new DocMessage(
      this.document,
      {
        type: "sync-step-1",
        sv: getEncryptedStateVector(
          this.activeSnapshotId ?? "",
          this.serverVersion,
        ),
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  /**
   * Handles an {@link EncryptedStateVector} by getting the {@link EncryptedSyncStep2}
   * and returning a {@link DocMessage} with the {@link EncryptedSyncStep2}.
   */
  public async handleSyncStep1(
    syncStep1: EncryptedStateVector,
  ): Promise<DocMessage<ClientContext>> {
    const decoded = decodeFromStateVector(syncStep1);
    let snapshot: EncryptedSnapshot | null = null;
    let updates: DecodedEncryptedUpdatePayload[] = [];

    if (!decoded.snapshotId && this.activeSnapshot) {
      snapshot = this.activeSnapshot;
    }

    if (decoded.snapshotId === this.activeSnapshotId) {
      updates = Array.from(this.pendingUpdates.values()).filter(
        (update) => update.snapshotId === decoded.snapshotId,
      );
    }

    const encryptedSyncStep2 = encodeToSyncStep2({
      snapshot: snapshot ?? undefined,
      updates,
    });

    return new DocMessage(
      this.document,
      {
        type: "sync-step-2",
        update: encryptedSyncStep2,
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  /**
   * Handles an {@link EncryptedSyncStep2} by decrypting the updates and applying them to the {@link Y.Doc}.
   * When this was an initial sync (server sent snapshot + updates), returns a compaction snapshot message
   * so the server can store it as the new active snapshot and avoid replaying the update log for future syncs.
   */
  public async handleSyncStep2(
    syncStep2: EncryptedSyncStep2,
  ): Promise<Message | void> {
    const decodedSyncStep2 = decodeFromSyncStep2(syncStep2);
    const hadSnapshot = !!decodedSyncStep2.snapshot;
    const hadUpdates = decodedSyncStep2.updates.length > 0;
    if (decodedSyncStep2.snapshot) {
      await this.applySnapshot(decodedSyncStep2.snapshot);
      await this.applyQueuedUpdates(decodedSyncStep2.snapshot.id);
    }
    await this.applyUpdates(decodedSyncStep2.updates);

    if (hadSnapshot && hadUpdates) {
      return this.createSnapshotMessage();
    }
  }

  /**
   * Handles an {@link EncryptedUpdatePayload} by decrypting the updates and applying them to the {@link Y.Doc}.
   */
  public async handleUpdate(payload: EncryptedUpdatePayload): Promise<void> {
    const decoded = decodeEncryptedUpdate(payload);
    if (decoded.type === "snapshot") {
      await this.applySnapshot(decoded.snapshot);
      await this.applyQueuedUpdates(decoded.snapshot.id);
      return;
    }
    await this.applyUpdates(decoded.updates);
  }

  /**
   * Handles an {@link AwarenessUpdateMessage} by decrypting it and applying it to the {@link Awareness}.
   */
  public async handleAwarenessUpdate(
    update: AwarenessUpdateMessage,
  ): Promise<void> {
    applyAwarenessUpdate(
      this.awareness,
      await this.decryptUpdate(update),
      getSyncTransactionOrigin(this.ydoc),
    );
  }

  /**
   * Handles an {@link AwarenessRequestMessage} by encrypting the {@link AwarenessUpdateMessage} and returning a {@link AwarenessMessage}.
   */
  public async handleAwarenessRequest(): Promise<
    AwarenessMessage<ClientContext>
  > {
    return new AwarenessMessage(
      this.document,
      {
        type: "awareness-update",
        update: (await this.encryptUpdate(
          encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
        )) as AwarenessUpdateMessage,
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  /**
   * Handles an {@link Update} by encrypting it and returning a {@link DocMessage}.
   */
  public async onUpdate(update: Update): Promise<Message> {
    if (!this.activeSnapshotId) {
      return this.createSnapshotMessage();
    }
    const encryptedUpdate = await this.encryptUpdate(update);
    const updatePayload = this.createUpdatePayload(encryptedUpdate);
    return new DocMessage(
      this.document,
      {
        type: "update",
        update: encodeEncryptedUpdateMessages([updatePayload]),
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  /**
   * Creates a snapshot message for the current document state.
   */
  public async createSnapshotMessage(): Promise<Message> {
    const snapshot = await this.createSnapshot();
    return new DocMessage(
      this.document,
      {
        type: "update",
        update: encodeEncryptedSnapshot(snapshot),
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  /**
   * Handles an {@link AwarenessUpdateMessage} by encrypting it and returning a {@link AwarenessMessage}.
   */
  public async onAwarenessUpdate(
    update: AwarenessUpdateMessage,
  ): Promise<Message> {
    const encryptedUpdate = await this.encryptUpdate(update);

    return new AwarenessMessage(
      this.document,
      {
        type: "awareness-update",
        update: encryptedUpdate as AwarenessUpdateMessage,
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }
}
