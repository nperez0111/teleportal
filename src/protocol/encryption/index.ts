import { decryptUpdate, encryptUpdate } from "../../encryption-key";
import type { Update, StateVector } from "../types";
import { DocMessage, AwarenessMessage, type Message } from "../message-types";
import {
  decodeFauxStateVector,
  decodeFauxUpdateList,
  encodeFauxStateVector,
  encodeFauxUpdate,
} from "../../storage/encrypted/encoding";
import * as Y from "yjs";

export type EncryptedMessage<Context extends Record<string, unknown>> =
  Message<Context>;

/**
 * Encrypts a message using the provided encryption key.
 * This is a first-class protocol feature that handles encryption at the protocol level.
 */
export async function encryptMessage<Context extends Record<string, unknown>>(
  message: Message<Context>,
  key: CryptoKey,
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
        // For sync-step-1, we create a faux state vector
        const fauxStateVector = encodeFauxStateVector({ messageId: "1" });
        
        return new DocMessage(
          message.document,
          {
            type: message.payload.type,
            sv: fauxStateVector,
          },
          message.context,
          true,
        );
      }
      case "sync-step-2":
      case "update": {
        const { update } = message.payload;
        const encryptedUpdate = await encryptUpdate(key, update);
        const fauxUpdate = encodeFauxUpdate(encryptedUpdate);

        return new DocMessage(
          message.document,
          {
            type: message.payload.type as "sync-step-2" | "update",
            update: fauxUpdate,
          },
          message.context,
          true,
        );
      }
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
  documentName: string,
): Promise<Message<Context>> {
  try {
    if (message.document !== documentName) {
      // Ignore messages for other documents
      throw new Error("Message is not for the specified document");
    }

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
export function createEncryptionTransform<Context extends Record<string, unknown>>(
  key: CryptoKey,
): TransformStream<Message<Context>, EncryptedMessage<Context>> {
  return new TransformStream({
    async transform(chunk, controller) {
      try {
        const encryptedMessage = await encryptMessage(chunk, key);
        controller.enqueue(encryptedMessage);
      } catch (error) {
        controller.error(new Error("Failed to encrypt message", { cause: error }));
      }
    },
  });
}

/**
 * Creates a transform stream that decrypts messages.
 */
export function createDecryptionTransform<Context extends Record<string, unknown>>(
  key: CryptoKey,
  documentName: string,
): TransformStream<EncryptedMessage<Context>, Message<Context>> {
  return new TransformStream({
    async transform(chunk, controller) {
      try {
        const decryptedMessage = await decryptMessage(chunk, key, documentName);
        controller.enqueue(decryptedMessage);
      } catch (error) {
        controller.error(new Error("Failed to decrypt message", { cause: error }));
      }
    },
  });
}

/**
 * Utility function to check if a message is encrypted.
 */
export function isEncryptedMessage<Context extends Record<string, unknown>>(
  message: Message<Context>,
): message is EncryptedMessage<Context> {
  return message.encrypted;
}

/**
 * Utility function to get the encryption key from a message context.
 */
export function getEncryptionKeyFromContext<Context extends Record<string, unknown> & { key?: CryptoKey }>(
  message: Message<Context>,
): CryptoKey | undefined {
  return message.context.key;
}

// Export utilities
export * from "./utils";