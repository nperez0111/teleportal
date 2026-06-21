import { ClientContext, Observable, type StateVector } from "teleportal";
import {
  type DecryptedBinary,
  decryptUpdate as defaultDecryptUpdate,
  type EncryptedBinary,
  encryptUpdate as defaultEncryptUpdate,
} from "teleportal/encryption-key";
import {
  AwarenessMessage,
  AwarenessUpdateMessage,
  DocMessage,
  Message,
  type VersionedSyncStep2Update,
  type VersionedUpdate,
} from "teleportal/protocol";
import type { EncryptedUpdatePayload, SidecarCompaction } from "teleportal/protocol/encryption";
import {
  decodeContentEncryptedPayload,
  encodeContentEncryptedPayload,
  encryptUpdateContent,
  decodeSidecar,
  mergeSidecars,
  restoreContent,
  compactSidecars,
  hashSidecar,
} from "teleportal/protocol/encryption";
import type { IndexedSidecar } from "teleportal/protocol/encryption";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness.js";
import * as Y from "yjs";
import { getSyncTransactionOrigin, YDocSinkHandler, YDocSourceHandler } from "../ydoc";

type EncryptionClientEvents = {
  "send-message": (message: Message) => void;
};

export class EncryptionClient
  extends Observable<EncryptionClientEvents>
  implements YDocSinkHandler, YDocSourceHandler
{
  static COMPACTION_THRESHOLD = 25;

  public document: string;
  public ydoc: Y.Doc;
  public awareness: Awareness;
  public key: CryptoKey;
  #decryptUpdate: (key: CryptoKey, encryptedUpdate: EncryptedBinary) => Promise<DecryptedBinary>;
  #encryptUpdate: (key: CryptoKey, update: DecryptedBinary) => Promise<EncryptedBinary>;
  #pendingCompaction: SidecarCompaction | null = null;
  #receivedSidecars: EncryptedBinary[] = [];

  constructor({
    document,
    ydoc,
    awareness,
    key,
    decryptUpdate,
    encryptUpdate,
  }: {
    document: string;
    ydoc?: Y.Doc;
    awareness?: Awareness;
    key: CryptoKey;
    decryptUpdate?: (key: CryptoKey, encryptedUpdate: EncryptedBinary) => Promise<DecryptedBinary>;
    encryptUpdate?: (key: CryptoKey, update: DecryptedBinary) => Promise<EncryptedBinary>;
  }) {
    super();
    this.ydoc = ydoc ?? new Y.Doc();
    this.awareness = awareness ?? new Awareness(this.ydoc);
    this.document = document;
    this.key = key;
    this.#decryptUpdate = decryptUpdate ?? defaultDecryptUpdate;
    this.#encryptUpdate = encryptUpdate ?? defaultEncryptUpdate;
  }

  public destroy(): void {}

  public encryptUpdate(update: DecryptedBinary): Promise<EncryptedBinary> {
    return this.#encryptUpdate(this.key, update);
  }

  public decryptUpdate(encryptedUpdate: EncryptedBinary): Promise<DecryptedBinary> {
    return this.#decryptUpdate(this.key, encryptedUpdate);
  }

  private async decryptAndApply(
    structureUpdate: Uint8Array,
    encryptedSidecars: EncryptedBinary[],
  ): Promise<void> {
    if (structureUpdate.length === 0) return;

    const sidecars = [];
    for (const encrypted of encryptedSidecars) {
      const sidecarBytes = await this.decryptUpdate(encrypted);
      sidecars.push(decodeSidecar(sidecarBytes));
    }

    const fullUpdate = restoreContent(structureUpdate, mergeSidecars(sidecars));
    Y.applyUpdateV2(this.ydoc, fullUpdate, getSyncTransactionOrigin(this.ydoc));
  }

  /**
   * Sends sync-step-1 with the local Y.js state vector.
   */
  public async start(): Promise<Message> {
    return new DocMessage(
      this.document,
      {
        type: "sync-step-1",
        sv: Y.encodeStateVector(this.ydoc) as StateVector,
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  /**
   * Responds to the server's sync-step-1 echo with a diff of local-only state.
   * Includes any pending compaction from handleSyncStep2.
   */
  public async handleSyncStep1(syncStep1: Uint8Array): Promise<DocMessage<ClientContext>> {
    const diff = Y.encodeStateAsUpdateV2(this.ydoc, syncStep1);
    const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(this.key, diff, 2);

    const compaction = this.#pendingCompaction;
    this.#pendingCompaction = null;

    const payload = encodeContentEncryptedPayload({
      structureUpdate,
      encryptedSidecars: [encryptedSidecar],
      compaction: compaction ?? undefined,
    });

    return new DocMessage(
      this.document,
      {
        type: "sync-step-2",
        update: { version: 2, data: payload } as unknown as VersionedSyncStep2Update,
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  /**
   * Applies the server's sync-step-2 diff to the local Y.Doc.
   * If multiple sidecars are received, compacts them for piggy-backing
   * on the next handleSyncStep1 response.
   */
  public async handleSyncStep2(syncStep2: VersionedSyncStep2Update): Promise<void> {
    const decoded = decodeContentEncryptedPayload(
      syncStep2.data as unknown as EncryptedUpdatePayload,
    );
    await this.decryptAndApply(decoded.structureUpdate, decoded.encryptedSidecars);

    if (decoded.encryptedSidecars.length >= 2) {
      const compacted = await compactSidecars(this.key, decoded.encryptedSidecars);
      if (compacted) {
        const sourceHashes = decoded.encryptedSidecars.map(hashSidecar);
        this.#pendingCompaction = {
          sidecar: compacted.encrypted,
          index: compacted.index,
          hash: compacted.hash,
          sourceHashes,
        };
      }
    }
  }

  /**
   * Pushes encrypted sidecars onto the accumulator and triggers compaction
   * when the threshold is reached. Used by both handleUpdate (incoming)
   * and onUpdate (outgoing) so that single-client edits are compacted too.
   */
  async #accumulate(...sidecars: EncryptedBinary[]): Promise<void> {
    this.#receivedSidecars.push(...sidecars);

    if (this.#receivedSidecars.length >= EncryptionClient.COMPACTION_THRESHOLD) {
      const compacted = await compactSidecars(this.key, this.#receivedSidecars);
      if (compacted) {
        const sourceHashes = this.#receivedSidecars.map(hashSidecar);
        this.#pendingCompaction = {
          sidecar: compacted.encrypted,
          index: compacted.index,
          hash: compacted.hash,
          sourceHashes,
        };
      }
      this.#receivedSidecars = [];
    }
  }

  /**
   * Applies an incremental update from a peer.
   * Accumulates encrypted sidecars for incremental compaction.
   */
  public async handleUpdate(update: VersionedUpdate): Promise<void> {
    const decoded = decodeContentEncryptedPayload(update.data as EncryptedUpdatePayload);
    await this.decryptAndApply(decoded.structureUpdate, decoded.encryptedSidecars);
    await this.#accumulate(...decoded.encryptedSidecars);
  }

  /**
   * Decrypts and applies an encrypted awareness update.
   */
  public async handleAwarenessUpdate(update: AwarenessUpdateMessage): Promise<void> {
    applyAwarenessUpdate(
      this.awareness,
      await this.decryptUpdate(update),
      getSyncTransactionOrigin(this.ydoc),
    );
  }

  /**
   * Encrypts a local Y.js update and returns a doc message for sending.
   * Consumes any pending compaction (from sync or incremental accumulation)
   * and includes it in the outgoing payload. Also accumulates the outgoing
   * sidecar for future compaction so single-client edits are compacted too.
   */
  public async onUpdate(update: VersionedUpdate): Promise<Message> {
    const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(
      this.key,
      update.data,
      update.version,
    );

    const compaction = this.#pendingCompaction;
    this.#pendingCompaction = null;

    const payload = encodeContentEncryptedPayload({
      structureUpdate,
      encryptedSidecars: [encryptedSidecar],
      compaction: compaction ?? undefined,
    });

    const message = new DocMessage(
      this.document,
      {
        type: "update",
        update: { version: 2, data: payload } as unknown as VersionedUpdate,
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );

    // Accumulate AFTER building the payload — this sidecar will be referenced
    // by a future compaction, by which time the server will have stored it.
    await this.#accumulate(encryptedSidecar);

    return message;
  }

  public async createCompactedSidecar(
    sidecars: EncryptedBinary[],
    _structureUpdate: Uint8Array,
  ): Promise<IndexedSidecar | null> {
    return compactSidecars(this.key, sidecars);
  }

  public async handleAwarenessRequest(): Promise<AwarenessMessage<ClientContext>> {
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

  public async onAwarenessUpdate(update: AwarenessUpdateMessage): Promise<Message> {
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
