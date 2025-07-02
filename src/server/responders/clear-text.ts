import * as Y from "yjs";

import type { Message, ServerContext, Update } from "teleportal";
import {
  DocMessage,
  getEmptyStateVector,
  getEmptyUpdate,
} from "teleportal/protocol";
import type { Document } from "teleportal/server";
import type { DocumentStorage } from "teleportal/storage";
import { MessageResponder } from "./types";

/**
 * A responder that handles clear text messages.
 */
export class ClearTextResponder extends MessageResponder {
  constructor(private readonly storage: DocumentStorage) {
    super();
  }

  async onMessage<Context extends ServerContext>({
    message,
    document,
  }: {
    message: Message<Context>;
    document: Document<Context>;
  }): Promise<void> {
    const logger = document.logger
      .withContext({
        name: "clear-text-responder",
      })
      .withMetadata({
        clientId: message.context.clientId,
        messageId: message.id,
        documentId: document.id,
      });
    if (message.encrypted !== this.storage.encrypted) {
      throw new Error(
        "Message encryption and storage encryption are mismatched",
        {
          cause: {
            messageEncrypted: message.encrypted,
            storageEncrypted: this.storage.encrypted,
          },
        },
      );
    }
    if (message.type === "doc" && message.payload.type === "sync-step-1") {
      logger.trace("got a sync-step-1 from client");

      const client = Array.from(document.clients.values()).find(
        (c) => c.id === message.context.clientId,
      );
      if (!client) {
        throw new Error(`Client not found`, {
          cause: {
            clientId: message.context.clientId,
          },
        });
      }

      try {
        const { update, stateVector } = (await this.storage.fetch(
          document.id,
        )) ?? {
          // TODO we can make a hook for a fallback file to load the update from?
          update: getEmptyUpdate(),
          stateVector: getEmptyStateVector(),
        };
        logger.trace("sending sync-step-2");

        await client.send(
          new DocMessage(
            document.name,
            {
              type: "sync-step-2",
              update: Y.diffUpdateV2(update, message.payload.sv) as Update,
            },
            message.context,
            false,
          ),
        );
        logger.trace("sending sync-step-1");
        await client.send(
          new DocMessage(
            document.name,
            {
              type: "sync-step-1",
              sv: stateVector,
            },
            message.context,
            false,
          ),
        );
      } catch (err) {
        logger.withError(err).error("failed to send sync-step-2");
      }
      // No need to broadcast sync-step-1 messages, they are just for coordinating with the server
      return;
    }

    await document.broadcast(message);

    // TODO should this be blocking? Could we be smarter about compaction in memory? Take a look at store-updates.ts
    if (
      message.type === "doc" &&
      (message.payload.type === "sync-step-2" ||
        message.payload.type === "update")
    ) {
      logger.trace("writing to store");
      await this.storage.write(document.id, message.payload.update);
    }
  }

  async destroy<Context extends ServerContext>(
    document: Document<Context>,
  ): Promise<void> {
    await this.storage.unload(document.id);
  }
}
