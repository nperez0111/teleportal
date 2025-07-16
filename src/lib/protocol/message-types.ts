import { digest } from "lib0/hash/sha256";
import { encodeMessage } from ".";
import {
  AwarenessUpdateMessage,
  DecodedAwarenessUpdateMessage,
  DecodedSyncStep1,
  DecodedSyncStep2,
  DecodedSyncDone,
  DecodedUpdateStep,
  DecodedAuthMessage,
  DocStep,
  EncodedDocUpdateMessage,
  DecodedAwarenessRequest,
} from "./types";
import { toBase64 } from "lib0/buffer";

/**
 * A Y.js message which concerns a document or awareness update.
 */
export type BinaryMessage =
  | EncodedDocUpdateMessage<DocStep>
  | AwarenessUpdateMessage;

/**
 * A decoded Y.js document update, which was deserialized from a {@link Uint8Array}.
 * Can apply to either a document or awareness update.
 */
export type Message<Context extends Record<string, unknown> = any> =
  | AwarenessMessage<Context>
  | DocMessage<Context>;

/**
 * A decoded Y.js document update, which was deserialized from a {@link Uint8Array}.
 *
 * This is an untrusted update at this point, as it has not been validated by the server for access control rights.
 */
export type RawReceivedMessage = Message<any>;

/**
 * A decoded Y.js awareness update, which was deserialized from a {@link Uint8Array}.
 *
 * This is an untrusted update at this point, as it has not been validated by the server for access control rights.
 */
export class AwarenessMessage<Context extends Record<string, unknown>> {
  public type = "awareness" as const;
  public context: Context;
  #encoded: BinaryMessage | undefined;
  #id: string | undefined;

  constructor(
    public document: string,
    public payload: DecodedAwarenessUpdateMessage | DecodedAwarenessRequest,
    context?: Context,
    public encrypted: boolean = false,
    encoded?: BinaryMessage,
  ) {
    this.context = context ?? ({} as Context);
    this.#encoded = encoded;
  }

  public get encoded() {
    return this.#encoded ?? (this.#encoded = encodeMessage(this));
  }

  public get id() {
    return this.#id ?? (this.#id = toBase64(digest(this.encoded)));
  }

  public resetEncoded() {
    this.#encoded = undefined;
    this.#id = undefined;
  }
}

/**
 * A received doc message, which was deserialized from a {@link Uint8Array}.
 *
 * It also supports decoding the underlying {@link DocStep} and encoding it back to a {@link SendableDocMessage}.
 */
export class DocMessage<Context extends Record<string, unknown>> {
  public type = "doc" as const;
  public context: Context;
  #encoded: BinaryMessage | undefined;
  #id: string | undefined;

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
    this.context = context ?? ({} as Context);
    this.#encoded = encoded;
  }

  public get encoded() {
    return this.#encoded ?? (this.#encoded = encodeMessage(this));
  }

  public get id() {
    return this.#id ?? (this.#id = toBase64(digest(this.encoded)));
  }

  public resetEncoded() {
    this.#encoded = undefined;
    this.#id = undefined;
  }
}
