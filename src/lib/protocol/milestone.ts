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
    snapshot,
    getSnapshot,
  }: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
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

    return {
      id,
      name,
      documentId,
      createdAt,
    };
  }

  public static encodeMetaDoc(milestones: Milestone[]): Uint8Array {
    return encoding.encode((encoder) => {
      for (let i = 0; i < milestones.length; i++) {
        Milestone.encodeMeta(milestones[i], encoder);
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
    const { id, name, documentId, createdAt } = Milestone.decodeMeta(
      source,
      decoder,
    );
    const snapshot = decoding.readTailAsUint8Array(
      decoder,
    ) as MilestoneSnapshot;

    return new Milestone({
      id,
      name,
      documentId,
      createdAt,
      snapshot,
    });
  }

  public toJSON(): {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
  } {
    return {
      id: this.id,
      name: this.name,
      documentId: this.documentId,
      createdAt: this.createdAt,
    };
  }

  public toString(): string {
    return `Milestone(id: ${this.id}, name: ${this.name}, documentId: ${this.documentId}, createdAt: ${this.createdAt}, snapshot: ${this.snapshot ? "loaded" : "lazy"})`;
  }
}
