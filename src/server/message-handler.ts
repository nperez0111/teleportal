import type { Message, ServerContext, StateVector, Update } from "teleportal";
import { DocMessage, getEmptyStateVector, getEmptyUpdate } from "teleportal";
import * as Y from "yjs";
import {
  decodeFauxStateVector,
  decodeFauxUpdateList,
  encodeFauxUpdateList,
  getEmptyFauxUpdateList,
} from "../storage/encrypted/encoding";
import type { Client } from "./client";
import { Document } from "./document";
import type { Logger } from "./logger";
import type { BlobStorageManager } from "./blob-storage";
import { BlobMessage } from "../protocol/message-types";
import { segmentFileForUpload } from "../protocol/utils";

/**
 * The MessageHandler class is responsible for handling messages from clients.
 *
 * It is responsible for checking if a client has permission to access a document,
 * and for handling the message if it does.
 */
export type MessageHandlerOptions<Context extends ServerContext> = {
  logger: Logger;
  checkPermission: (ctx: {
    context: Context;
    document: string;
    documentId: string;
    message: Message<Context>;
    type: "read" | "write";
  }) => Promise<boolean>;
  blobStorageManager?: BlobStorageManager;
};

export class MessageHandler<Context extends ServerContext> {
  private logger: Logger;
  private options: MessageHandlerOptions<Context>;

  constructor(options: MessageHandlerOptions<Context>) {
    this.options = options;
    this.logger = options.logger.withContext({ name: "message-handler" });
  }

  /**
   * Check if a client has permission to access a document.
   */
  public async checkAuthorization(
    clientId: string,
    message: Message<Context>,
    type: "read" | "write",
  ): Promise<boolean> {
    const documentId = Document.getDocumentId(message);
    const logger = this.logger.withMetadata({
      clientId,
      context: message.context,
      document: message.document,
      documentId,
    });

    logger.trace("checking permission to read");

    const hasPermission = await this.options.checkPermission({
      context: message.context,
      document: message.document,
      documentId,
      message,
      type,
    });

    if (hasPermission) {
      logger.trace("client is authorized");
      return true;
    }

    logger.trace("client is not authorized");

    return false;
  }

  /**
   * Send an authorization denied message to a client
   */
  public async sendAuthDenied(
    client: Client<Context>,
    message: Message<Context>,
    reason?: string,
  ): Promise<void> {
    await client.send(
      new DocMessage(
        message.document,
        {
          type: "auth-message",
          permission: "denied",
          reason:
            reason ||
            `Insufficient permissions to access document ${message.document}`,
        },
        message.context,
        message.encrypted,
      ),
    );
  }

  /**
   * Process a message for a document
   */
  public async handleMessage(
    message: Message<Context>,
    document: Document<Context>,
    client: Client<Context>,
  ): Promise<void> {
    const logger = this.logger.withContext({
      clientId: client.id,
      context: message.context,
      document: message.document,
      documentId: document.id,
    });

    try {
      logger.trace("processing message");

      // Validate encryption consistency
      if (message.encrypted !== document.encrypted) {
        throw new Error(
          "Message encryption and document encryption are mismatched",
          {
            cause: {
              messageEncrypted: message.encrypted,
              documentEncrypted: document.encrypted,
            },
          },
        );
      }

      const strategy = message.encrypted
        ? new EncryptedMessageStrategy<Context>()
        : new ClearTextMessageStrategy<Context>();

      switch (message.type) {
        case "doc":
          switch (message.payload.type) {
            case "sync-step-1":
              await this.handleSync(
                message,
                document,
                client,
                logger,
                strategy,
              );
              return;
            case "update":
              await document.broadcast(message);
            // purposefully fall through to sync-step-2 handling
            case "sync-step-2":
              logger.trace("writing to store");
              await document.write(message.payload.update);
              return;
            case "auth-message":
              throw new Error("auth-message not supported");
            default:
              throw new Error("unknown message type");
          }
        case "blob":
          await this.handleBlobMessage(message, document, client, logger);
          return;
        default:
          // Broadcast the message to all clients
          await document.broadcast(message);
      }

      logger.trace("message processed successfully");
    } catch (e) {
      logger.withError(e).error("Failed to handle message");
      throw e;
    }
  }

  /**
   * Handle blob messages (blob-part and request-blob)
   */
  private async handleBlobMessage(
    message: Message<Context>,
    document: Document<Context>,
    client: Client<Context>,
    logger: Logger,
  ): Promise<void> {
    if (!this.options.blobStorageManager) {
      logger.warn("blob storage manager not configured, ignoring blob message");
      return;
    }

    if (message.type !== "blob") {
      throw new Error("Expected blob message");
    }

    switch (message.payload.type) {
      case "blob-part":
        await this.handleBlobPart(message, document, client, logger);
        break;
      case "request-blob":
        await this.handleRequestBlob(message, document, client, logger);
        break;
      default:
        throw new Error("unknown blob payload type");
    }
  }

  /**
   * Handle blob-part messages
   */
  private async handleBlobPart(
    message: Message<Context>,
    document: Document<Context>,
    client: Client<Context>,
    logger: Logger,
  ): Promise<void> {
    if (message.type !== "blob" || message.payload.type !== "blob-part") {
      throw new Error("Expected blob-part message");
    }

    logger.trace("handling blob part");

    // Store the blob part
    await this.options.blobStorageManager!.handleBlobPart(message.payload);

    // Broadcast the blob part to other clients
    await document.broadcast(message);
  }

  /**
   * Handle request-blob messages
   */
  private async handleRequestBlob(
    message: Message<Context>,
    document: Document<Context>,
    client: Client<Context>,
    logger: Logger,
  ): Promise<void> {
    if (message.type !== "blob" || message.payload.type !== "request-blob") {
      throw new Error("Expected request-blob message");
    }

    logger.trace("handling request blob");

    // Get the blob data
    const result = await this.options.blobStorageManager!.handleRequestBlob(
      message.payload,
    );

    if (result.data && result.metadata) {
      // Send the blob parts back to the requesting client
      const segments = segmentFileForUpload(
        result.data,
        result.metadata.name,
        result.metadata.contentType,
        document.name,
      );

      for (const segment of segments) {
        // Create a properly typed blob message
        const blobMessage = new BlobMessage(
          document.name,
          segment.payload,
          message.context,
          message.encrypted,
        );
        await client.send(blobMessage);
      }

      logger
        .withMetadata({
          contentId: message.payload.contentId,
          segments: segments.length,
        })
        .trace("sent blob parts to client");
    } else {
      logger
        .withMetadata({ contentId: message.payload.contentId })
        .trace("blob not found");
    }
  }

  /**
   * Handle sync-step-1 messages
   */
  private async handleSync(
    message: DocMessage<Context>,
    document: Document<Context>,
    client: Client<Context>,
    logger: Logger,
    strategy: MessageStrategy<Context>,
  ): Promise<void> {
    logger.trace("got a sync-step-1 from client");

    const clientInDocument = Array.from(document.clients.values()).find(
      (c) => c.id === message.context.clientId,
    );
    if (!clientInDocument) {
      throw new Error(`Client not found`, {
        cause: { clientId: message.context.clientId },
      });
    }

    try {
      // client started with a sync-step-1 so we send a sync-step-2, then a sync-step-1 (to which they will reply with a sync-step-2, at which point we've synced completely)
      const { update, stateVector } = await strategy.fetchUpdate(
        document,
        message,
      );

      logger.trace("sending sync-step-2");
      await clientInDocument.send(
        new DocMessage(
          document.name,
          {
            type: "sync-step-2",
            update,
          },
          message.context,
          document.encrypted,
        ),
      );

      // TODO not implemented for encrypted documents
      if (!document.encrypted) {
        logger.trace("sending sync-step-1");
        await clientInDocument.send(
          new DocMessage(
            document.name,
            { type: "sync-step-1", sv: stateVector },
            message.context,
            document.encrypted,
          ),
        );
      }
    } catch (err) {
      logger.withError(err).error("failed to send sync-step-2");
    }
  }
}

/**
 * Strategy interface for handling different message types
 */
interface MessageStrategy<Context extends ServerContext> {
  fetchUpdate(
    document: Document<Context>,
    message: DocMessage<Context>,
  ): Promise<{ update: Update; stateVector: StateVector }>;
}

/**
 * Strategy for handling clear text messages
 */
class ClearTextMessageStrategy<Context extends ServerContext>
  implements MessageStrategy<Context>
{
  async fetchUpdate(
    document: Document<Context>,
    message: DocMessage<Context>,
  ): Promise<{ update: Update; stateVector: StateVector }> {
    const { update, stateVector } = (await document.fetch()) ?? {
      update: getEmptyUpdate(),
      stateVector: getEmptyStateVector(),
    };

    // Type guard to ensure this is a sync-step-1 message
    if (message.type !== "doc" || message.payload.type !== "sync-step-1") {
      throw new Error("Expected sync-step-1 message");
    }

    return {
      update: Y.diffUpdateV2(update, message.payload.sv) as Update,
      stateVector,
    };
  }
}

/**
 * Strategy for handling encrypted messages
 */
class EncryptedMessageStrategy<Context extends ServerContext>
  implements MessageStrategy<Context>
{
  async fetchUpdate(
    document: Document<Context>,
    message: DocMessage<Context>,
  ): Promise<{ update: Update; stateVector: StateVector }> {
    const { update, stateVector } = (await document.fetch()) ?? {
      update: getEmptyFauxUpdateList(),
      stateVector: getEmptyStateVector(),
    };

    // Type guard to ensure this is a sync-step-1 message
    if (message.payload.type !== "sync-step-1") {
      throw new Error("Expected sync-step-1 message");
    }

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

    return {
      update: encodeFauxUpdateList(sendUpdates),
      stateVector,
    };
  }
}
