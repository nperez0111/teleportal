import * as Y from "yjs";

import type { Message, ServerContext, Update } from "../lib";
import { DocMessage, getEmptyStateVector, getEmptyUpdate } from "../protocol";
import { type Document } from "../server/document";
import { logger } from "../server/logger";
import {
  type DocumentStorage,
  LowLevelDocumentStorage,
} from "./document-storage";

export class StorageAdapter extends LowLevelDocumentStorage {
  private logger = logger.child({ name: "storage-adapter" });

  public static fromStorage(
    storage: DocumentStorage | LowLevelDocumentStorage,
  ) {
    if (storage.type === "document-storage") {
      return new StorageAdapter(storage);
    }
    return storage;
  }

  protected constructor(private readonly storage: DocumentStorage) {
    super();
  }

  async onMessage<Context extends ServerContext>(
    message: Message<Context>,
    document: Document<Context>,
  ): Promise<void> {
    if (message.type === "doc" && message.payload.type === "sync-step-1") {
      this.logger.trace(
        {
          messageId: message.id,
          documentId: document.id,
        },
        "got a sync-step-1 from client",
      );

      const client = document.server.clients.get(message.context.clientId);
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
        this.logger.trace(
          {
            messageId: message.id,
            documentId: document.id,
          },
          "sending sync-step-2",
        );
        await client.send(
          new DocMessage(document.name, {
            type: "sync-step-2",
            update: Y.diffUpdateV2(update, message.payload.sv) as Update,
          }),
          document,
        );
        this.logger.trace(
          {
            messageId: message.id,
            documentId: document.id,
          },
          "sending sync-step-1",
        );
        await client.send(
          new DocMessage(document.name, {
            type: "sync-step-1",
            sv: stateVector,
          }),
          document,
        );
      } catch (err) {
        this.logger.error(
          {
            err,
            clientId: message.context.clientId,
            messageId: message.id,
            documentId: document.id,
          },
          "failed to send sync-step-2",
        );
      }
      // No need to broadcast sync-step-1 messages, they are just for coordinating with the server
      return;
    }

    await document.broadcast(message, message.context.clientId);

    // TODO should this be blocking? Could we be smarter about compaction in memory? Take a look at store-updates.ts
    if (
      message.type === "doc" &&
      (message.payload.type === "sync-step-2" ||
        message.payload.type === "update")
    ) {
      this.logger.trace(
        {
          messageId: message.id,
          documentId: document.id,
        },
        "writing to store",
      );
      await this.storage.write(document.id, message.payload.update);
    }
  }

  async onUnload<Context extends ServerContext>(
    document: Document<Context>,
  ): Promise<void> {
    await this.storage.unload(document.id);
  }
}
