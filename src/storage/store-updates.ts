import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";

import type { Message, Tag } from "teleportal";

export type UpdateMessage = Tag<Uint8Array, "update-message">;

export const getWriteDocUpdateStream = () =>
  new TransformStream<
    Message<any>,
    { document: string; update: UpdateMessage }
  >({
    transform(chunk, controller) {
      if (
        chunk.type === "doc" &&
        (chunk.payload.type === "sync-step-2" ||
          chunk.payload.type === "update")
      ) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint8Array(encoder, chunk.payload.update);
        controller.enqueue({
          document: chunk.document,
          update: encoding.toUint8Array(encoder) as UpdateMessage,
        });
      }
    },
  });

/**
 * Compacts a readable stream of {@link UpdateMessage}s into a single {@link UpdateMessage}
 * @returns
 */
export async function compactToSingleUpdate(
  updateStream: ReadableStream<UpdateMessage>,
): Promise<UpdateMessage> {
  let mergedUpdates: Uint8Array | null = null;

  await updateStream.pipeTo(
    new WritableStream({
      write(chunk) {
        const decoder = decoding.createDecoder(chunk);
        const update = decoding.readVarUint8Array(decoder);
        if (mergedUpdates) {
          mergedUpdates = Y.mergeUpdatesV2([mergedUpdates, update]);
        } else {
          mergedUpdates = update;
        }
        const tail = decoding.readTailAsUint8Array(decoder);
        if (tail.length) {
          throw new Error(
            "Unexpected bytes at the end of the update, expected proper alignment of updates",
            {
              cause: {
                tail,
              },
            },
          );
        }
      },
    }),
  );

  return mergedUpdates! as UpdateMessage;
}
