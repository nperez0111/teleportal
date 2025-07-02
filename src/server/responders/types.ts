import type { Message, ServerContext } from "teleportal";
import type { Document } from "teleportal/server";

export abstract class MessageResponder {
  /**
   * Called when a message is received for a document.
   */
  abstract onMessage<Context extends ServerContext>(ctx: {
    message: Message<Context>;
    document: Document<Context>;
  }): Promise<void> | void;

  /**
   * Called when a responder is being destroyed
   */
  destroy<Context extends ServerContext>(
    document: Document<Context>,
  ): Promise<void> | void {
    // no-op
    return;
  }
}
