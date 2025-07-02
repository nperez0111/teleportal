import { DocMessage, Message, ServerContext } from "teleportal";
import type { Document } from "teleportal/server";
import type { DocumentStorage } from "teleportal/storage";
import {
  decodeFauxStateVector,
  decodeFauxUpdateList,
  encodeFauxStateVector,
  encodeFauxUpdateList,
  getEmptyFauxUpdateList,
} from "../../storage/encrypted/encoding";
import { MessageResponder } from "./types";

/**
 * A storage implementation that is backed by unstorage.
 * This is a zero-knowledge storage implementation, which means that it does not inspect the contents of the documents at any point.
 */
export class EncryptedResponder extends MessageResponder {
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
        name: "encrypted-responder",
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
          update: getEmptyFauxUpdateList(),
          stateVector: encodeFauxStateVector({
            messageId: "implement",
          }),
        };
        logger.trace("sending sync-step-2");

        const fauxStateVector = decodeFauxStateVector(message.payload.sv);
        const updates = decodeFauxUpdateList(update);
        const updateIndex = updates.findIndex(
          (update) => update.messageId === fauxStateVector.messageId,
        );
        // Pick the updates that the client doesn't have
        const sendUpdates = updates.slice(
          0,
          // Didn't find any? Send them all
          updateIndex === -1 ? updates.length : updateIndex,
        );
        const encodedUpdates = encodeFauxUpdateList(sendUpdates);

        logger.trace("sending sync-step-2");
        await client.send(
          new DocMessage(document.name, {
            type: "sync-step-2",
            update: encodedUpdates,
          }),
        );
        logger.trace("sending sync-step-1");

        // TODO send a sync-step-1 that tells the client to compact the document
        // They will send a sync-step-2 with the compacted updates which we can consider a milestone
        // await client.send(
        //   new DocMessage(document.name, {
        //     type: "sync-step-1",
        //     sv: encodeFauxStateVector({
        //       messageId: "compact",
        //     }),
        //   }),
        //   document,
        // );
      } catch (err) {
        logger.withError(err).error("failed to send sync-step-2");
      }
      // No need to broadcast sync-step-1 messages, they are just for coordinating with the server
      return;
    }

    // Broadcast the message to all clients
    await document.broadcast(message);

    if (
      message.type === "doc" &&
      (message.payload.type === "sync-step-2" ||
        message.payload.type === "update")
    ) {
      logger.trace("writing to store");
      await this.storage.write(document.id, message.payload.update);
    }
  }
}
