import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  compose,
  DocMessage,
  Message,
  sync,
  toBinaryTransport,
  type YSink,
  type YSource,
  type YTransport,
  type YBinaryTransport,
} from "../lib";
import {
  decodeFauxStateVector,
  decodeFauxUpdateList,
  encodeFauxStateVector,
  encodeFauxUpdate,
} from "../storage/encrypted/encoding";
import { decryptUpdate, encryptUpdate } from "../encryption";
import { withLogger } from "./logger";
import { getYTransportFromYDoc } from "./ydoc";

export type EncryptedMessage<Context extends Record<string, unknown>> =
  Message<Context>;

/**
 * Reads a an encrypted message and decodes it into a {@link Message}.
 */
export const getMessageDecryptor = <
  Context extends Record<string, unknown>,
>(options: {
  key: CryptoKey;
}) =>
  new TransformStream<EncryptedMessage<Context>, Message<Context>>({
    async transform(chunk, controller) {
      if (chunk.type !== "doc") {
        // passthrough other messages
        controller.enqueue(chunk);
        return;
      }

      switch (chunk.payload.type) {
        // unused right now
        case "sync-step-1": {
          const { sv } = chunk.payload;
          const decoded = decodeFauxStateVector(sv);
          console.log("decoded", decoded);
          controller.enqueue(chunk);
          return;
        }
        case "sync-step-2":
        case "update": {
          const { update } = chunk.payload;
          const decoded = decodeFauxUpdateList(update);
          await Promise.all(
            decoded.map(async ({ update }) => {
              const decryptedUpdate = await decryptUpdate(options.key, update);
              controller.enqueue(
                new DocMessage(
                  chunk.document,
                  {
                    type: chunk.payload.type as "sync-step-2" | "update",
                    update: decryptedUpdate,
                  },
                  chunk.context,
                  false,
                ),
              );
            }),
          );
          return;
        }
        default: {
          throw new Error(
            `Unknown message type: ${(chunk.payload as any).type}`,
          );
        }
      }
    },
  });

export const getMessageEncryptor = <
  Context extends Record<string, unknown>,
>(options: {
  key: CryptoKey;
}) =>
  new TransformStream<Message<Context>, EncryptedMessage<Context>>({
    async transform(chunk, controller) {
      if (chunk.type !== "doc") {
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
        default: {
          throw new Error(
            `Unknown message type: ${(chunk.payload as any).type}`,
          );
        }
      }
    },
  });

/**
 * Wraps a transport in encryption, encrypting all document messages that are sent through the transport.
 */
export function withEncryption<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: YTransport<Context, AdditionalProperties>,
  options: { key: CryptoKey },
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

export function getEncryptedYDocTransport({
  ydoc,
  document,
  awareness = new Awareness(ydoc),
  debug = false,
  key,
}: {
  ydoc: Y.Doc;
  document: string;
  awareness?: Awareness;
  debug?: boolean;
  key: CryptoKey;
}): YBinaryTransport<{
  ydoc: Y.Doc;
  awareness: Awareness;
  synced: Promise<void>;
  key: CryptoKey;
}> {
  let transport = getYTransportFromYDoc({
    ydoc,
    document,
    awareness,
    asClient: true,
  });
  if (debug) {
    transport = withLogger(transport);
  }
  const encryptedTransport = withEncryption(transport, { key });

  return toBinaryTransport(encryptedTransport, {
    clientId: "remote",
  });
}
