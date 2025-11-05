import { withMessageValidator } from "teleportal/transports";
import { type Message, type ServerContext, DocMessage } from "teleportal";
import type { Logger } from "teleportal/server";
import type { ServerOptions } from "../api/types";

export class Engine<Context extends ServerContext> {
  #logger: Logger;
  #options: ServerOptions<Context>;

  constructor(options: { logger: Logger; serverOptions: ServerOptions<Context> }) {
    this.#logger = options.logger.child().withContext({ name: "engine" });
    this.#options = options.serverOptions;
  }

  wrapTransport(transport: import("teleportal").Transport<Context>, sendAuth: (m: Message<Context>) => Promise<void>) {
    return withMessageValidator(transport, {
      isAuthorized: async (message, type) => {
        if (!this.#options.checkPermission) return true;
        const ok = await this.#options.checkPermission({
          context: message.context,
          document: message.document,
          documentId: message.document,
          message: message as Message<Context>,
          type,
        });
        if (!ok) {
          await sendAuth(
            new DocMessage(
              message.document,
              { type: "auth-message", permission: "denied", reason: `Insufficient permissions to access document ${message.document}` },
              message.context,
              message.encrypted,
            ) as any,
          );
          return false;
        }
        return true;
      },
    });
  }
}
