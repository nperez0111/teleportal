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
  type ContentEncryptedUpdate,
  type IndexedSidecar,
  createKeyedTokenizer,
  compactSidecars,
  decodeContentEncryptedPayload,
  decodeSidecar,
  encodeContentEncryptedPayload,
  encodeSidecar,
  hashSidecar,
  mergeSidecars,
  restoreContent,
  stripContent,
} from "teleportal/protocol/encryption";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness.js";
import * as Y from "yjs";
import { getSyncTransactionOrigin, YDocSinkHandler, YDocSourceHandler } from "../ydoc";

type EncryptionClientEvents = {
  /** Emitted when the client wants to send a message (e.g. periodic compaction). */
  "send-message": (message: Message) => void;
};

export class EncryptionClient
  extends Observable<EncryptionClientEvents>
  implements YDocSinkHandler, YDocSourceHandler
{
  /** Number of accumulated sidecars before a compaction is produced on the next send. */
  static COMPACTION_THRESHOLD = 25;

  public document: string;
  public ydoc: Y.Doc;
  public awareness: Awareness;
  public key: CryptoKey;
  #decryptUpdate: (key: CryptoKey, encryptedUpdate: EncryptedBinary) => Promise<DecryptedBinary>;
  #encryptUpdate: (key: CryptoKey, update: DecryptedBinary) => Promise<EncryptedBinary>;
  #receivedSidecars: EncryptedBinary[] = [];
  #cachedTokenizer: ((str: string) => string) | null = null;

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

  async #getTokenizer(): Promise<(str: string) => string> {
    if (this.#cachedTokenizer) return this.#cachedTokenizer;
    const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", this.key));
    this.#cachedTokenizer = createKeyedTokenizer(rawKey);
    return this.#cachedTokenizer;
  }

  async #encryptContent(
    update: Uint8Array,
    version: 1 | 2,
  ): Promise<ContentEncryptedUpdate> {
    const tokenizer = await this.#getTokenizer();
    const { update: structureUpdate, sidecar } = stripContent(update, version, tokenizer);
    const sidecarBytes = encodeSidecar(sidecar);
    const encryptedSidecar = await this.#encryptUpdate(this.key, sidecarBytes);
    return { structureUpdate, encryptedSidecar };
  }

  /**
   * Releases any resources held by this client. Call when the client is no longer used.
   */
  public destroy(): void {}

  /**
   * Encrypts a {@link DecryptedBinary} using the {@link CryptoKey}.
   */
  public encryptUpdate(update: DecryptedBinary): Promise<EncryptedBinary> {
    return this.#encryptUpdate(this.key, update);
  }

  /**
   * Decrypts an {@link EncryptedBinary} using the {@link CryptoKey}.
   */
  public decryptUpdate(encryptedUpdate: EncryptedBinary): Promise<DecryptedBinary> {
    return this.#decryptUpdate(this.key, encryptedUpdate);
  }

  /**
   * Decrypts the encrypted sidecars, restores the full Y.js update from the
   * structure-only update + sidecar content, and applies it to the {@link Y.Doc}.
   */
  private async decryptAndApply(
    structureUpdate: Uint8Array,
    encryptedSidecars: EncryptedBinary[],
  ): Promise<void> {
    if (structureUpdate.length === 0) return;

    const decryptedBytes = await Promise.all(
      encryptedSidecars.map((encrypted) => this.decryptUpdate(encrypted)),
    );
    const sidecars = decryptedBytes.map(decodeSidecar);

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
   * Includes a compaction computed lazily if enough sidecars have accumulated.
   */
  public async handleSyncStep1(syncStep1: Uint8Array): Promise<DocMessage<ClientContext>> {
    const diff = Y.encodeStateAsUpdateV2(this.ydoc, syncStep1);
    const [{ structureUpdate, encryptedSidecar }, compaction] = await Promise.all([
      this.#encryptContent(diff, 2),
      this.#takePendingCompaction(),
    ]);

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
   * Applies the server's sync-step-2 diff to the local Y.Doc, then accumulates
   * the received sidecars so a later send can compact them.
   */
  public async handleSyncStep2(syncStep2: VersionedSyncStep2Update): Promise<void> {
    const decoded = decodeContentEncryptedPayload(
      syncStep2.data as unknown as EncryptedUpdatePayload,
    );
    await this.decryptAndApply(decoded.structureUpdate, decoded.encryptedSidecars);
    this.#accumulate(...decoded.encryptedSidecars);
  }

  /**
   * Records encrypted sidecars (known to be stored on the server) for a future
   * compaction. The compaction itself is computed lazily in
   * {@link #takePendingCompaction} so no crypto work is spent on a compaction
   * that never gets sent. Used by both handleUpdate (incoming) and onUpdate
   * (outgoing) so single-client edits are compacted too.
   */
  #accumulate(...sidecars: EncryptedBinary[]): void {
    this.#receivedSidecars.push(...sidecars);
  }

  /**
   * Compute a compaction from the accumulated sidecars, but only once enough
   * have piled up to be worth collapsing. Captures and clears the accumulator
   * before awaiting so a concurrent send can't compact the same set twice.
   * Returns null when below threshold or nothing to compact.
   */
  async #takePendingCompaction(): Promise<SidecarCompaction | null> {
    if (this.#receivedSidecars.length < EncryptionClient.COMPACTION_THRESHOLD) {
      return null;
    }
    const sources = this.#receivedSidecars;
    this.#receivedSidecars = [];
    const compacted = await compactSidecars(this.key, sources);
    if (!compacted) return null;
    return {
      sidecar: compacted.encrypted,
      index: compacted.index,
      hash: compacted.hash,
      sourceHashes: sources.map(hashSidecar),
    };
  }

  /**
   * Applies an incremental update from a peer.
   * Accumulates encrypted sidecars for incremental compaction.
   */
  public async handleUpdate(update: VersionedUpdate): Promise<void> {
    const decoded = decodeContentEncryptedPayload(update.data as EncryptedUpdatePayload);
    await this.decryptAndApply(decoded.structureUpdate, decoded.encryptedSidecars);
    this.#accumulate(...decoded.encryptedSidecars);
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
   * Computes a compaction lazily (only when enough sidecars have accumulated)
   * and includes it in the outgoing payload. Also accumulates the outgoing
   * sidecar for future compaction so single-client edits are compacted too.
   */
  public async onUpdate(update: VersionedUpdate): Promise<Message> {
    const [{ structureUpdate, encryptedSidecar }, compaction] = await Promise.all([
      this.#encryptContent(update.data, update.version),
      this.#takePendingCompaction(),
    ]);

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
    this.#accumulate(encryptedSidecar);

    return message;
  }

  /**
   * Compacts multiple encrypted sidecars into a single {@link IndexedSidecar}.
   * Returns `null` when compaction produces no output.
   */
  public async createCompactedSidecar(
    sidecars: EncryptedBinary[],
    _structureUpdate: Uint8Array,
  ): Promise<IndexedSidecar | null> {
    return compactSidecars(this.key, sidecars);
  }

  /**
   * Handles an awareness request by encrypting the local awareness state and
   * returning an {@link AwarenessMessage}.
   */
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

  /**
   * Encrypts a local awareness update and returns an {@link AwarenessMessage} for sending.
   */
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
