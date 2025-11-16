import { toBase64 } from "lib0/buffer";
import { digest } from "lib0/hash/sha256";
import { encodeMessage } from "./encode";
import type {
  AwarenessUpdateMessage,
  DecodedAckMessage,
  DecodedAuthMessage,
  DecodedAwarenessRequest,
  DecodedAwarenessUpdateMessage,
  DecodedFileProgress,
  DecodedFileRequest,
  DecodedSyncDone,
  DecodedSyncStep1,
  DecodedSyncStep2,
  DecodedUpdateStep,
  DocStep,
  EncodedDocUpdateMessage,
  FileProgressMessage,
  FileRequestMessage,
} from "./types";

/**
 * A binary representation of a {@link Message} which concerns a document or awareness update.
 */
export type BinaryMessage =
  | EncodedDocUpdateMessage<DocStep>
  | AwarenessUpdateMessage
  | FileRequestMessage
  | FileProgressMessage;

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
export abstract class CustomMessage<Context extends Record<string, unknown>> {
  public abstract type: string;
  public abstract context: Context;
  public abstract document: string | undefined;
  public abstract payload: any;
  public abstract encrypted: boolean;

  constructor(encoded?: BinaryMessage) {
    this.#encoded = encoded;
  }

  #encoded: BinaryMessage | undefined;
  #id: string | undefined;

  public get encoded(): BinaryMessage {
    return this.#encoded ?? (this.#encoded = this.encode());
  }

  encode(): BinaryMessage {
    return encodeMessage(this as any);
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
    return `Message(type: ${this.type}, document: ${this.document}, payload: ${JSON.stringify(this.payload)}, context: ${JSON.stringify(this.context)}, encrypted: ${this.encrypted}, id: ${this.id}, encoded: ${this.encoded})`;
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
> extends CustomMessage<Context> {
  public type = "awareness" as const;
  public context: Context;

  constructor(
    public document: string,
    public payload: DecodedAwarenessUpdateMessage | DecodedAwarenessRequest,
    context?: Context,
    public encrypted: boolean = false,
    encoded?: BinaryMessage,
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
> extends CustomMessage<Context> {
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
    encoded?: BinaryMessage,
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
> extends CustomMessage<Context> {
  public type = "ack" as const;
  public context: Context;
  public encrypted: boolean = false;

  constructor(
    public document: string,
    public payload: DecodedAckMessage,
    context?: Context,
  ) {
    super();
    this.context = context ?? ({} as Context);
  }
}

/**
 * A message used for streaming binary file uploads/downloads.
 * File messages are not tied to a specific document.
 */
export class FileMessage<
  Context extends Record<string, unknown>,
> extends CustomMessage<Context> {
  public type = "file" as const;
  public context: Context;
  public document: undefined = undefined;

  constructor(
    public payload: DecodedFileRequest | DecodedFileProgress,
    context?: Context,
    public encrypted: boolean = false,
    encoded?: BinaryMessage,
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
