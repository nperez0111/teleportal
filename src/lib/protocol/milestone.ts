import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { MilestoneSnapshot } from "teleportal";

/**
 * A {@link Milestone} is a snapshot of a document at a point in time.
 * This allows a there to be document history, comparing document content at different points in time and more.
 *
 * @note a {@link Milestone} can be defined lazily, this allows flexibility for retrieving the metadata of a {@link Milestone} versus it's underlying {@link MilestoneSnapshot} which actually has the document content. Use the {@link Milestone.fetchSnapshot} method to load the content into memory
 */
export class Milestone {
  /**
   * The identifier for the milestone
   */
  public id: string;
  /**
   * The named version of this milestone, if not specified, will be an incrementing number based on the current number of snapshots available
   */
  public name: string;
  /**
   * The documentId that this Milestone is tracking
   */
  public documentId: string;
  /**
   * The UTC timestamp of when this Milestone was created
   */
  public createdAt: number;

  public deletedAt?: number;
  public deletedBy?: string;
  public lifecycleState?: "active" | "archived" | "deleted" | "expired";
  public retentionPolicyId?: string;
  public expiresAt?: number;
  /**
   * Information about who/what created this milestone.
   * - `type: "user"` → userId from message context
   * - `type: "system"` → nodeId (server instance that created it)
   */
  public createdBy: { type: "user" | "system"; id: string };

  private getSnapshot?: (
    documentId: string,
    id: string,
  ) => Promise<MilestoneSnapshot>;
  private snapshot?: MilestoneSnapshot;

  constructor({
    id,
    name,
    documentId,
    createdAt,
    deletedAt,
    deletedBy,
    lifecycleState,
    retentionPolicyId,
    expiresAt,
    createdBy,
    snapshot,
    getSnapshot,
  }: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    deletedAt?: number;
    deletedBy?: string;
    lifecycleState?: "active" | "archived" | "deleted" | "expired";
    retentionPolicyId?: string;
    expiresAt?: number;
    createdBy: { type: "user" | "system"; id: string };
  } & (
    | {
        snapshot: MilestoneSnapshot;
        getSnapshot?: undefined;
      }
    | {
        snapshot?: undefined;
        getSnapshot: (
          documentId: string,
          id: string,
        ) => Promise<MilestoneSnapshot>;
      }
  )) {
    this.id = id;
    this.name = name;
    this.createdAt = createdAt;
    this.documentId = documentId;
    this.deletedAt = deletedAt;
    this.deletedBy = deletedBy;
    this.lifecycleState = lifecycleState;
    this.retentionPolicyId = retentionPolicyId;
    this.expiresAt = expiresAt;
    this.createdBy = createdBy;
    this.snapshot = snapshot;
    this.getSnapshot = getSnapshot;
  }

  /**
   * Will tell you if the {@link Milestone}'s {@link MilestoneSnapshot} has already been loaded into memory on this instance
   *
   * Because {@link Milestone}s can be loaded lazily, it is not given the content is available immediately
   */
  public get loaded(): boolean {
    return !!this.snapshot;
  }

  #loadingPromise: Promise<MilestoneSnapshot> | undefined = undefined;

  /**
   * A {@link Milestone} can be defined lazily, so this will load it's content into memory and return the {@link MilestoneSnapshot} that it loaded.
   */
  public async fetchSnapshot(): Promise<MilestoneSnapshot> {
    if (this.snapshot) {
      return this.snapshot;
    }
    if (this.#loadingPromise) {
      return this.#loadingPromise;
    }
    if (this.getSnapshot) {
      this.#loadingPromise = this.getSnapshot(this.documentId, this.id)
        .then((snapshot) => {
          this.snapshot = snapshot;
          this.#loadingPromise = undefined;
          return snapshot;
        })
        .catch((error) => {
          // Clear the loading promise on error to allow retry
          this.#loadingPromise = undefined;
          throw error;
        });
      return this.#loadingPromise;
    }
    throw new Error(
      "getSnapshot should be defined if snapshot is not already available",
    );
  }

  /**
   * A {@link Milestone} can be serialized into a {@link Uint8Array} for easy binary storage. To deserialize, see the {@link Milestone.decode} static method
   */
  public encode(): Uint8Array {
    const snapshot = this.snapshot;
    if (!snapshot) {
      throw new Error(
        "Snapshot has not been fetched, so encoding this Milestone instance would be incomplete",
      );
    }
    return encoding.encode((encoder) => {
      // Write the meta as the head
      Milestone.encodeMeta(this, encoder);
      // snapshot.update
      encoding.writeUint8Array(encoder, snapshot);
    });
  }

  public static encodeMeta(
    milestone: Milestone,
    existingEncoder?: encoding.Encoder,
  ): Uint8Array {
    function encode(encoder: encoding.Encoder): Uint8Array {
      // Y
      encoding.writeUint8(encoder, 0x59);
      // J
      encoding.writeUint8(encoder, 0x4a);
      // S
      encoding.writeUint8(encoder, 0x53);
      // version
      encoding.writeUint8(encoder, 0x01);
      // documentId
      encoding.writeVarString(encoder, milestone.documentId);
      // id
      encoding.writeVarString(encoder, milestone.id);
      // name
      encoding.writeVarString(encoder, milestone.name);
      // createdAt
      encoding.writeFloat64(encoder, milestone.createdAt);

      // Flags for optional fields
      let flags = 0;
      if (milestone.deletedAt !== undefined) flags |= Math.trunc(1);
      if (milestone.deletedBy !== undefined) flags |= 1 << 1;
      if (milestone.lifecycleState !== undefined) flags |= 1 << 2;
      if (milestone.retentionPolicyId !== undefined) flags |= 1 << 3;
      if (milestone.expiresAt !== undefined) flags |= 1 << 4;

      encoding.writeUint8(encoder, flags);

      if (milestone.deletedAt !== undefined)
        encoding.writeFloat64(encoder, milestone.deletedAt);
      if (milestone.deletedBy !== undefined)
        encoding.writeVarString(encoder, milestone.deletedBy);
      if (milestone.lifecycleState !== undefined)
        encoding.writeVarString(encoder, milestone.lifecycleState);
      if (milestone.retentionPolicyId !== undefined)
        encoding.writeVarString(encoder, milestone.retentionPolicyId);
      if (milestone.expiresAt !== undefined)
        encoding.writeFloat64(encoder, milestone.expiresAt);

      encoding.writeUint8(encoder, milestone.createdBy.type === "user" ? 1 : 0);
      encoding.writeVarString(encoder, milestone.createdBy.id);

      return existingEncoder
        ? encoding.toUint8Array(encoder)
        : (undefined as any);
    }

    return existingEncoder ? encode(existingEncoder) : encoding.encode(encode);
  }

  public static decodeMeta(
    source: Uint8Array,
    existingDecoder?: decoding.Decoder,
  ) {
    const decoder = existingDecoder
      ? existingDecoder
      : decoding.createDecoder(source);
    const Y = decoding.readUint8(decoder);
    const J = decoding.readUint8(decoder);
    const S = decoding.readUint8(decoder);
    if (Y !== 0x59 || J !== 0x4a || S !== 0x53) {
      throw new Error("Invalid message prefix");
    }
    const version = decoding.readUint8(decoder);
    if (version !== 0x01) {
      throw new Error("Version not supported", { cause: { version } });
    }
    const documentId = decoding.readVarString(decoder);
    const id = decoding.readVarString(decoder);
    const name = decoding.readVarString(decoder);
    const createdAt = decoding.readFloat64(decoder);

    let deletedAt: number | undefined;
    let deletedBy: string | undefined;
    let lifecycleState:
      | "active"
      | "archived"
      | "deleted"
      | "expired"
      | undefined;
    let retentionPolicyId: string | undefined;
    let expiresAt: number | undefined;

    const flags = decoding.readUint8(decoder);
    if (flags & Math.trunc(1)) deletedAt = decoding.readFloat64(decoder);
    if (flags & (1 << 1)) deletedBy = decoding.readVarString(decoder);
    if (flags & (1 << 2))
      lifecycleState = decoding.readVarString(decoder) as any;
    if (flags & (1 << 3)) retentionPolicyId = decoding.readVarString(decoder);
    if (flags & (1 << 4)) expiresAt = decoding.readFloat64(decoder);

    const createdByType = decoding.readUint8(decoder) === 1 ? "user" : "system";
    const createdById = decoding.readVarString(decoder);
    const createdBy: { type: "user" | "system"; id: string } = {
      type: createdByType,
      id: createdById,
    };

    return {
      id,
      name,
      documentId,
      createdAt,
      deletedAt,
      deletedBy,
      lifecycleState,
      retentionPolicyId,
      expiresAt,
      createdBy,
    };
  }

  public static encodeMetaDoc(milestones: Milestone[]): Uint8Array {
    return encoding.encode((encoder) => {
      for (const milestone of milestones) {
        Milestone.encodeMeta(milestone, encoder);
      }
    });
  }

  public static decodeMetaDoc(
    source: Uint8Array,
    getSnapshot: NonNullable<Milestone["getSnapshot"]>,
  ): Milestone[] {
    const decoder = decoding.createDecoder(source);
    const milestones = [] as Milestone[];
    while (decoding.hasContent(decoder)) {
      const milestoneCtx = Milestone.decodeMeta(source, decoder);

      milestones.push(
        new Milestone(Object.assign(milestoneCtx, { getSnapshot })),
      );
    }

    return milestones;
  }

  /**
   * Deserializes an encoded {@link Milestone} from the {@link Uint8Array} it was serialized to, and creates a new instance of a {@link Milestone} from it.
   */
  public static decode(source: Uint8Array): Milestone {
    const decoder = decoding.createDecoder(source);
    // Read the meta header
    const {
      id,
      name,
      documentId,
      createdAt,
      deletedAt,
      deletedBy,
      lifecycleState,
      retentionPolicyId,
      expiresAt,
      createdBy,
    } = Milestone.decodeMeta(source, decoder);
    const snapshot = decoding.readTailAsUint8Array(
      decoder,
    ) as MilestoneSnapshot;

    return new Milestone({
      id,
      name,
      documentId,
      createdAt,
      deletedAt,
      deletedBy,
      lifecycleState,
      retentionPolicyId,
      expiresAt,
      createdBy,
      snapshot,
    });
  }

  public toJSON(): {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    deletedAt?: number;
    deletedBy?: string;
    lifecycleState?: "active" | "archived" | "deleted" | "expired";
    retentionPolicyId?: string;
    expiresAt?: number;
    createdBy: { type: "user" | "system"; id: string };
  } {
    return {
      id: this.id,
      name: this.name,
      documentId: this.documentId,
      createdAt: this.createdAt,
      deletedAt: this.deletedAt,
      deletedBy: this.deletedBy,
      lifecycleState: this.lifecycleState,
      retentionPolicyId: this.retentionPolicyId,
      expiresAt: this.expiresAt,
      createdBy: this.createdBy,
    };
  }

  public toString(): string {
    return `Milestone(id: ${this.id}, name: ${this.name}, documentId: ${this.documentId}, createdAt: ${this.createdAt}, lifecycle: ${this.lifecycleState || "active"}, snapshot: ${this.snapshot ? "loaded" : "lazy"})`;
  }
}
