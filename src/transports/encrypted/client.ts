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
import type { EncryptedUpdatePayload } from "teleportal/protocol/encryption";
import {
  decodeContentEncryptedPayload,
  encodeContentEncryptedPayload,
  encryptUpdateContent,
  decodeSidecar,
  mergeSidecars,
  restoreContent,
  compactSidecars,
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
  public document: string;
  public ydoc: Y.Doc;
  public awareness: Awareness;
  public key: CryptoKey;
  #decryptUpdate: (key: CryptoKey, encryptedUpdate: EncryptedBinary) => Promise<DecryptedBinary>;
  #encryptUpdate: (key: CryptoKey, update: DecryptedBinary) => Promise<EncryptedBinary>;

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
    Y.applyUpdate(this.ydoc, fullUpdate, getSyncTransactionOrigin(this.ydoc));
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
   */
  public async handleSyncStep1(syncStep1: Uint8Array): Promise<DocMessage<ClientContext>> {
    const diff = Y.encodeStateAsUpdate(this.ydoc, syncStep1);
    const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(this.key, diff, 1);

    const payload = encodeContentEncryptedPayload({
      structureUpdate,
      encryptedSidecars: [encryptedSidecar],
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
   */
  public async handleSyncStep2(syncStep2: VersionedSyncStep2Update): Promise<void> {
    const decoded = decodeContentEncryptedPayload(
      syncStep2.data as unknown as EncryptedUpdatePayload,
    );
    await this.decryptAndApply(decoded.structureUpdate, decoded.encryptedSidecars);
  }

  /**
   * Applies an incremental update from a peer.
   */
  public async handleUpdate(update: VersionedUpdate): Promise<void> {
    const decoded = decodeContentEncryptedPayload(update.data as EncryptedUpdatePayload);
    await this.decryptAndApply(decoded.structureUpdate, decoded.encryptedSidecars);
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
   */
  public async onUpdate(update: VersionedUpdate): Promise<Message> {
    const v1 = update.version === 2 ? Y.convertUpdateFormatV2ToV1(update.data) : update.data;
    const { structureUpdate, encryptedSidecar } = await encryptUpdateContent(this.key, v1, 1);

    const payload = encodeContentEncryptedPayload({
      structureUpdate,
      encryptedSidecars: [encryptedSidecar],
    });

    return new DocMessage(
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
