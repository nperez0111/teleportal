import { decryptUpdate, encryptUpdate } from "../../encryption-key";
import {
  compose,
  DocMessage,
  Message,
  sync,
  Update,
  type YSink,
  type YSource,
  type YTransport,
} from "teleportal";
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
 * Reads a an encrypted message and decodes it into a {@link Message}.
 */
export function getMessageDecryptor<
  Context extends Record<string, unknown>,
>(options: { key: CryptoKey; document: string }) {
  return new TransformStream<EncryptedMessage<Context>, Message<Context>>({
    async transform(chunk, controller) {
      try {
        if (chunk.document !== options.document) {
          // Ignore messages for other documents
          return;
        }

        if (chunk.type !== "doc") {
          chunk.encrypted = false;
          // passthrough other messages
          controller.enqueue(chunk);
          return;
        }

        switch (chunk.payload.type) {
          // unused right now
          case "sync-step-1": {
            // TODO: handle sync-step-1
            // const { sv } = chunk.payload;
            // const decoded = decodeFauxStateVector(sv);

            controller.enqueue(chunk);
            return;
          }
          case "sync-step-2":
          case "update": {
            const { update } = chunk.payload;
            const decoded = decodeFauxUpdateList(update);

            const decryptedUpdates = await Promise.all(
              decoded.map(async ({ update }) => {
                const decryptedUpdate = await decryptUpdate(
                  options.key,
                  update,
                );
                return decryptedUpdate;
              }),
            );

            // batches all the updates into a single update
            controller.enqueue(
              new DocMessage(
                chunk.document,
                {
                  type: chunk.payload.type as "sync-step-2" | "update",
                  update: Y.mergeUpdatesV2(decryptedUpdates) as Update,
                },
                chunk.context,
                false,
              ),
            );
            return;
          }
          case "auth-message": {
            // passthrough auth messages
            controller.enqueue(chunk);
            return;
          }
          default: {
            throw new Error(
              `Unknown message type: ${(chunk.payload as any).type}`,
            );
          }
        }
      } catch (e) {
        controller.error(
          new Error("Failed to decrypt message", { cause: { err: e } }),
        );
      }
    },
  });
}

export function getMessageEncryptor<
  Context extends Record<string, unknown>,
>(options: { key: CryptoKey }) {
  return new TransformStream<Message<Context>, EncryptedMessage<Context>>({
    async transform(chunk, controller) {
      try {
        if (chunk.type !== "doc") {
          chunk.encrypted = true;
          controller.enqueue(chunk);
          return;
        }
        switch (chunk.payload.type) {
          case "sync-step-1": {
            // const { sv } = chunk.payload;
            // Just ignoring the state vector for now
            const fauxStateVector = encodeFauxStateVector({ messageId: "1" });

            return controller.enqueue(
              new DocMessage(
                chunk.document,
                {
                  type: chunk.payload.type,
                  sv: fauxStateVector,
                },
                chunk.context,
                true,
              ),
            );
          }
          case "sync-step-2":
          case "update": {
            const { update } = chunk.payload;
            const encryptedUpdate = await encryptUpdate(options.key, update);
            const fauxUpdate = encodeFauxUpdate(encryptedUpdate);

            return controller.enqueue(
              new DocMessage(
                chunk.document,
                {
                  type: chunk.payload.type as "sync-step-2" | "update",
                  update: fauxUpdate,
                },
                chunk.context,
                true,
              ),
            );
          }
          case "auth-message": {
            // passthrough auth messages
            controller.enqueue(chunk);
            return;
          }
          default: {
            throw new Error(
              `Unknown message type: ${(chunk.payload as any).type}`,
            );
          }
        }
      } catch (e) {
        controller.error(
          new Error("Failed to encrypt message", { cause: { err: e } }),
        );
      }
    },
  });
}

/**
 * Wraps a transport in encryption, encrypting all document messages that are sent through the transport.
 */
export function withEncryption<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: YTransport<Context, AdditionalProperties>,
  options: { key: CryptoKey; document: string },
): YTransport<Context, AdditionalProperties & { key: CryptoKey }> {
  const reader = getMessageDecryptor<Context>(options);
  const writer = getMessageEncryptor<Context>(options);

  const decryptedSource: YSource<Context, any> = {
    readable: reader.readable,
  };
  const encryptedSink: YSink<Context, any> = {
    writable: writer.writable,
  };
  const encryptedTransport = compose(decryptedSource, encryptedSink);

  sync(encryptedTransport, transport);

  return {
    ...transport,
    key: options.key,
    readable: writer.readable,
    writable: reader.writable,
  };
}
