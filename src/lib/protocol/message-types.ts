import { toBase64 } from "lib0/buffer";
import { digest } from "lib0/hash/sha256";
import { encodeMessage } from "./encode";
import type {
  AwarenessRequestMessage,
  AwarenessUpdateMessage,
  DecodedAckMessage,
  DecodedAuthMessage,
  DecodedAwarenessRequest,
  DecodedAwarenessUpdateMessage,
  DecodedFileAuthMessage,
  DecodedFileDownload,
  DecodedFilePart,
  DecodedFileUpload,
  DecodedSyncDone,
  DecodedSyncStep1,
  DecodedSyncStep2,
  DecodedUpdateStep,
  DocStep,
  EncodedAckMessage,
  EncodedDocUpdateMessage,
  EncodedFileStep,
  FileStep,
} from "./types";

/**
 * A binary representation of a {@link Message} which concerns a document or awareness update.
 */
export type BinaryMessage =
  | EncodedDocUpdateMessage<DocStep>
  | AwarenessUpdateMessage
  | AwarenessRequestMessage
  | EncodedFileStep<FileStep>
  | EncodedAckMessage;

/**
 * A decoded Y.js document update, which was deserialized from a {@link BinaryMessage}.
 * Can apply to either a document or awareness update.
 */
export type Message<Context extends Record<string, unknown> = any> =
  | AwarenessMessage<Context>
  | DocMessage<Context>
  | AckMessage<Context>
  | FileMessage<Context>;

/**
 * A decoded Y.js document update, which was deserialized from a {@link BinaryMessage}.
 *
 * This is an untrusted update at this point, as it has not been validated by the server for access control rights.
 */
export type RawReceivedMessage = Message<any>;

/**
 * Base class for message types
 */
export abstract class CustomMessage<
  Context extends Record<string, unknown>,
  BinaryRepresentation extends BinaryMessage,
> {
  public abstract type: string;
  public abstract context: Context;
  public abstract document: string | undefined;
  public abstract payload: any;
  public abstract encrypted: boolean;

  constructor(encoded?: BinaryRepresentation) {
    this.#encoded = encoded;
  }

  #encoded: BinaryRepresentation | undefined;
  #id: string | undefined;

  public get encoded(): BinaryRepresentation {
    return this.#encoded ?? (this.#encoded = this.encode());
  }

  encode(): BinaryRepresentation {
    return encodeMessage(this as any) as BinaryRepresentation;
  }

  public get id(): string {
    return this.#id ?? (this.#id = toBase64(digest(this.encoded)));
  }

  public resetEncoded() {
    this.#encoded = undefined;
    this.#id = undefined;
  }

  public toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      document: this.document,
      payload: this.payload,
      context: this.context,
      encrypted: this.encrypted,
      id: this.id,
      encoded: this.encoded,
    };
  }

  public toString(): string {
    return `Message(type: ${this.type}, payload: ${JSON.stringify(this.payload)}, document: ${this.document}, context: ${JSON.stringify(this.context)}, encrypted: ${this.encrypted}, id: ${this.id})`;
  }

  public valueOf(): string {
    return this.id;
  }
}

/**
 * A decoded Y.js awareness update, which was deserialized from a {@link Uint8Array}.
 *
 * This is an untrusted update at this point, as it has not been validated by the server for access control rights.
 */
export class AwarenessMessage<
  Context extends Record<string, unknown>,
> extends CustomMessage<
  Context,
  AwarenessUpdateMessage | AwarenessRequestMessage
> {
  public type = "awareness" as const;
  public context: Context;

  constructor(
    public document: string,
    public payload: DecodedAwarenessUpdateMessage | DecodedAwarenessRequest,
    context?: Context,
    public encrypted: boolean = false,
    encoded?: AwarenessUpdateMessage | AwarenessRequestMessage,
  ) {
    super(encoded);
    this.context = context ?? ({} as Context);
  }
}

/**
 * A received doc message, which was deserialized from a {@link Uint8Array}.
 *
 * It also supports decoding the underlying {@link DocStep} and encoding it back to a {@link SendableDocMessage}.
 */
export class DocMessage<
  Context extends Record<string, unknown>,
> extends CustomMessage<Context, EncodedDocUpdateMessage<DocStep>> {
  public type = "doc" as const;
  public context: Context;

  constructor(
    public document: string,
    public payload:
      | DecodedSyncStep1
      | DecodedSyncStep2
      | DecodedSyncDone
      | DecodedUpdateStep
      | DecodedAuthMessage,
    context?: Context,
    public encrypted: boolean = false,
    encoded?: EncodedDocUpdateMessage<DocStep>,
  ) {
    super(encoded);
    this.context = context ?? ({} as Context);
  }
}

/**
 * A message that acknowledges the receipt of a message.
 */
export class AckMessage<
  Context extends Record<string, unknown>,
> extends CustomMessage<Context, EncodedAckMessage> {
  public type = "ack" as const;
  public context: Context;
  public encrypted: boolean = false;
  public document = undefined;

  constructor(
    public payload: DecodedAckMessage,
    context?: Context,
  ) {
    super();
    this.context = context ?? ({} as Context);
  }
}

/**
 * A file message for upload/download operations.
 */
export class FileMessage<
  Context extends Record<string, unknown>,
> extends CustomMessage<Context, EncodedFileStep<FileStep>> {
  public type = "file" as const;
  public context: Context;
  public document: string | undefined = undefined;

  constructor(
    public payload:
      | DecodedFileAuthMessage
      | DecodedFileUpload
      | DecodedFileDownload
      | DecodedFilePart,
    context?: Context,
    public encrypted: boolean = false,
    encoded?: EncodedFileStep<FileStep>,
  ) {
    super(encoded);
    this.context = context ?? ({} as Context);
  }
}

/**
 * Checks if a message is a binary message.
 * @param message - The message to check.
 * @returns Whether the message is a binary message.
 */
export const isBinaryMessage = (
  message: Uint8Array,
): message is BinaryMessage => {
  return (
    // Y
    message[0] === 0x59 &&
    // J
    message[1] === 0x4a &&
    // S
    message[2] === 0x53
  );
};
