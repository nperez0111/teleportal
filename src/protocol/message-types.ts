import { uuidv4 } from "lib0/random";
import { encodeMessage } from ".";
import {
  AwarenessUpdateMessage,
  DecodedAwarenessUpdateMessage,
  DecodedSyncStep1,
  DecodedSyncStep2,
  DecodedUpdateStep,
  DocStep,
  EncodedDocUpdateMessage,
} from "./types";

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
  public id = uuidv4();

  constructor(
    public document: string,
    public payload: DecodedAwarenessUpdateMessage,
    context?: Context,
  ) {
    this.context = context ?? ({} as Context);
  }

  public get encoded() {
    const encoded = encodeMessage(this);
    Object.defineProperty(this, "encoded", { value: encoded });
    return encoded;
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
  public id = uuidv4();

  constructor(
    public document: string,
    public payload: DecodedSyncStep1 | DecodedSyncStep2 | DecodedUpdateStep,
    context?: Context,
  ) {
    this.context = context ?? ({} as Context);
  }

  public get encoded() {
    const encoded = encodeMessage(this);
    Object.defineProperty(this, "encoded", { value: encoded });
    return encoded;
  }
}
