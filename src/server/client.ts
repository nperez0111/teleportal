import type { ServerContext, Message, AckMessage } from "teleportal";
import { emitWideEvent } from "./logger";
import { Observable } from "../lib/utils";

/**
 * The fate of a message the server sent to a client.
 *
 * `delivered: true` means the client acknowledged it — the strongest signal available, and
 * the point at which a sender can release whatever it was holding on the message's behalf.
 * Everything else is a reason it will never be acknowledged.
 */
export type DeliveryResult =
  | { delivered: true }
  | {
      delivered: false;
      /**
       * - `timeout` — no ack arrived in time. The client may still have applied it.
       * - `disconnected` — the connection went away first.
       * - `rejected` — the client refused it (a NACK carrying an error).
       * - `not-acknowledged` — the message is best-effort, so no ack was ever coming.
       */
      reason: "timeout" | "disconnected" | "rejected" | "not-acknowledged";
      error?: string;
    };

export type DeliveryCallback = (result: DeliveryResult) => void;

export interface ClientSendOptions {
  /**
   * Called once when the message's fate is known.
   *
   * Awaiting `send` only tells you the message reached the transport. This tells you
   * whether it landed, which is what a sender needs to clean up after itself.
   */
  onAck?: DeliveryCallback;
  /** How long to wait for the ack before reporting `timeout`. Defaults to 10s. */
  ackTimeoutMs?: number;
}

const DEFAULT_ACK_TIMEOUT_MS = 10_000;

export class Client<Context extends ServerContext> extends Observable<{
  "client-message": (ctx: {
    clientId: string;
    message: Message<Context>;
    direction: "out";
  }) => void;
}> {
  /**
   * The ID of the client.
   */
  public readonly id: string;
  #write: (message: Message<Context>) => void | Promise<void>;

  /**
   * Sent messages awaiting an ack, keyed by message id.
   *
   * Only messages sent *with* an `onAck` are tracked — the common path allocates nothing.
   * Ids are unique per message (see the nonce on `RpcMessage`), so two identical payloads
   * are two entries rather than one clobbering the other.
   */
  #pendingAcks = new Map<
    string,
    { callback: DeliveryCallback; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(args: { id: string; write: (message: Message<Context>) => void | Promise<void> }) {
    super();
    this.id = args.id;
    this.#write = args.write;
  }

  /**
   * Settle a pending message exactly once, clearing its timeout.
   *
   * Once-only matters: a late ack for a timed-out message, or a disconnect after an ack,
   * would otherwise fire a callback whose caller has already released its resources.
   */
  #settle(messageId: string, result: DeliveryResult) {
    const pending = this.#pendingAcks.get(messageId);
    if (!pending) return;
    this.#pendingAcks.delete(messageId);
    clearTimeout(pending.timer);
    try {
      pending.callback(result);
    } catch (error) {
      emitWideEvent("error", {
        event_type: "client_delivery_callback_failed",
        timestamp: new Date().toISOString(),
        client_id: this.id,
        message_id: messageId,
        error,
      });
    }
  }

  /**
   * Send a message to the client.
   * Direction: `Server -> Client`
   * @param message - The message to send.
   * @param options - Delivery tracking (see {@link ClientSendOptions}).
   * @returns A promise that resolves when the message is handed to the transport.
   */
  async send(message: Message<Context>, options?: ClientSendOptions): Promise<void> {
    this.call("client-message", {
      clientId: this.id,
      message,
      direction: "out",
    });

    const onAck = options?.onAck;
    if (onAck) {
      if (!message.requiresAck) {
        // Best-effort traffic is never acked, so a pending entry could only ever time out.
        // Say so now instead of making the caller wait for that.
        onAck({ delivered: false, reason: "not-acknowledged" });
      } else {
        const messageId = message.id;
        const timer = setTimeout(
          () => this.#settle(messageId, { delivered: false, reason: "timeout" }),
          options?.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS,
        );
        // Don't hold the process open waiting on an ack that may never come.
        (timer as { unref?: () => void }).unref?.();
        this.#pendingAcks.set(messageId, { callback: onAck, timer });
      }
    }

    try {
      await this.#write(message);
    } catch (error) {
      if (onAck) {
        this.#settle(message.id, { delivered: false, reason: "disconnected" });
      }
      emitWideEvent("error", {
        event_type: "client_send_failed",
        timestamp: new Date().toISOString(),
        client_id: this.id,
        message_id: message.id,
        document_id: message.document,
        message_type: message.type,
        error,
      });
      throw error;
    }
  }

  /**
   * Route an ack this client sent back, settling the message it refers to.
   *
   * An ack for something untracked is normal — most messages are sent without a callback —
   * so this is a no-op rather than an error.
   */
  handleAck(message: AckMessage<Context>) {
    // Reads defensively: this runs inside the per-client consume loop, where a throw would
    // end the loop and leave the socket open but unserved.
    const messageId = message.payload?.messageId;
    if (messageId === undefined) return;
    const error = message.payload?.error;
    this.#settle(
      messageId,
      error === undefined ? { delivered: true } : { delivered: false, reason: "rejected", error },
    );
  }

  /**
   * Tear the client down, reporting everything still in flight as undelivered.
   *
   * Without this a caller waiting on delivery would hang until each ack timeout — and a
   * long-lived server would keep the callbacks (and whatever they close over) alive.
   */
  destroy() {
    for (const messageId of Array.from(this.#pendingAcks.keys())) {
      this.#settle(messageId, { delivered: false, reason: "disconnected" });
    }
  }

  toString() {
    return `Client(id: ${this.id})`;
  }

  toJSON() {
    return {
      id: this.id,
    };
  }
}
