import * as Y from "yjs";
import { decryptUpdate, encryptUpdate } from "../../../encryption-key";
import { AwarenessMessage, DocMessage, type Message } from "../message-types";
import type { Update } from "../types";
import {
  decodeFauxUpdateList,
  encodeFauxStateVector,
  encodeFauxUpdate,
} from "./encoding";
import { EncryptionClient } from "../../../encryption-state-vector/client";

export * from "./encoding";

export type EncryptedMessage<Context extends Record<string, unknown>> =
  Message<Context>;

/**
 * Encrypts a message using the provided encryption key.
 * This is a first-class protocol feature that handles encryption at the protocol level.
 */
export async function encryptMessage<Context extends Record<string, unknown>>(
  message: Message<Context>,
  client: EncryptionClient,
): Promise<EncryptedMessage<Context>> {
  try {
    if (message.type !== "doc") {
      // Non-doc messages (awareness) are passed through but marked as encrypted
      return new AwarenessMessage(
        message.document,
        message.payload,
        message.context,
        true,
      );
    }

    switch (message.payload.type) {
      case "sync-step-1": {
        // For sync-step-1, we send the state vector
        return new DocMessage(
          message.document,
          {
            type: message.payload.type,
            sv: client.getEncryptedStateVector(),
          },
          message.context,
          true,
        );
      }
      case "sync-step-2": {
        return new DocMessage(
          message.document,
          {
            type: "sync-step-2",
            // TODO how to handle sync-step-2? It responds to sync-step-1 ( this is a full sync)
            update: await client.getEncryptedSyncStep2(),
          },
          message.context,
          true,
        );
      }
      case "update": {
        const { update } = message.payload;
        const encryptedUpdate = await encryptUpdate(key, update);
        const fauxUpdate = encodeFauxUpdate(encryptedUpdate);
        const encryptedUpdateMessage = await client.addMessage(message);
        return new DocMessage(
          message.document,
          {
            type: message.payload.type,
            update: fauxUpdate,
          },
          message.context,
          true,
        );
      }
      case "sync-done":
      case "auth-message": {
        // Auth messages are passed through
        return new DocMessage(
          message.document,
          message.payload,
          message.context,
          true,
        );
      }
      default: {
        throw new Error(
          `Unknown message type: ${(message.payload as any).type}`,
        );
      }
    }
  } catch (error) {
    throw new Error("Failed to encrypt message", { cause: error });
  }
}

/**
 * Decrypts a message using the provided encryption key.
 * This is a first-class protocol feature that handles decryption at the protocol level.
 */
export async function decryptMessage<Context extends Record<string, unknown>>(
  message: EncryptedMessage<Context>,
  key: CryptoKey,
): Promise<Message<Context>> {
  try {
    if (message.type !== "doc") {
      // Non-doc messages (awareness) are passed through but marked as not encrypted
      return new AwarenessMessage(
        message.document,
        message.payload,
        message.context,
        false,
      );
    }

    switch (message.payload.type) {
      case "sync-step-1": {
        // TODO: handle sync-step-1 properly
        // For now, just pass through
        return new DocMessage(
          message.document,
          message.payload,
          message.context,
          false,
        );
      }
      case "sync-step-2":
      case "update": {
        const { update } = message.payload;
        const decoded = decodeFauxUpdateList(update);

        const decryptedUpdates = await Promise.all(
          decoded.map(async ({ update }) => {
            const decryptedUpdate = await decryptUpdate(key, update);
            return decryptedUpdate;
          }),
        );

        // Batch all the updates into a single update
        const mergedUpdate = Y.mergeUpdatesV2(decryptedUpdates) as Update;

        return new DocMessage(
          message.document,
          {
            type: message.payload.type as "sync-step-2" | "update",
            update: mergedUpdate,
          },
          message.context,
          false,
        );
      }
      case "sync-done":
      case "auth-message": {
        // Auth messages are passed through
        return new DocMessage(
          message.document,
          message.payload,
          message.context,
          false,
        );
      }
      default: {
        throw new Error(
          `Unknown message type: ${(message.payload as any).type}`,
        );
      }
    }
  } catch (error) {
    throw new Error("Failed to decrypt message", { cause: error });
  }
}

/**
 * Creates a transform stream that encrypts messages.
 */
export function createEncryptionTransform<
  Context extends Record<string, unknown>,
>(
  key: CryptoKey,
): TransformStream<Message<Context>, EncryptedMessage<Context>> {
  return new TransformStream({
    async transform(chunk, controller) {
      try {
        const encryptedMessage = await encryptMessage(chunk, key);
        controller.enqueue(encryptedMessage);
      } catch (error) {
        controller.error(
          new Error("Failed to encrypt message", { cause: error }),
        );
      }
    },
  });
}

/**
 * Creates a transform stream that decrypts messages.
 */
export function createDecryptionTransform<
  Context extends Record<string, unknown>,
>(
  key: CryptoKey,
  documentName: string,
): TransformStream<EncryptedMessage<Context>, Message<Context>> {
  return new TransformStream({
    async transform(chunk, controller) {
      try {
        if (chunk.document !== documentName) {
          return;
        }

        const decryptedMessage = await decryptMessage(chunk, key);
        controller.enqueue(decryptedMessage);
      } catch (error) {
        controller.error(
          new Error("Failed to decrypt message", { cause: error }),
        );
      }
    },
  });
}
