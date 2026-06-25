import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";

import type { Message, Tag, VersionedSyncStep2Update, VersionedUpdate } from "teleportal";
import { convertToV2, convertSyncStep2ToV2 } from "teleportal/protocol";

export type UpdateMessage = Tag<Uint8Array, "update-message">;

export function extractDocUpdate(
  chunk: Message<any>,
): { document: string; update: UpdateMessage } | null {
  if (chunk.type === "doc" && chunk.payload.type === "update") {
    const v2 = convertToV2(chunk.payload.update as VersionedUpdate);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint8Array(encoder, v2);
    return {
      document: chunk.document,
      update: encoding.toUint8Array(encoder) as UpdateMessage,
    };
  } else if (chunk.type === "doc" && chunk.payload.type === "sync-step-2") {
    const v2 = convertSyncStep2ToV2(chunk.payload.update as VersionedSyncStep2Update);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint8Array(encoder, v2);
    return {
      document: chunk.document,
      update: encoding.toUint8Array(encoder) as UpdateMessage,
    };
  }
  return null;
}

export function compactUpdates(updates: UpdateMessage[]): UpdateMessage {
  let mergedUpdates: Uint8Array | null = null;

  for (const chunk of updates) {
    const decoder = decoding.createDecoder(chunk);
    const update = decoding.readVarUint8Array(decoder);
    mergedUpdates = mergedUpdates ? Y.mergeUpdatesV2([mergedUpdates, update]) : update;
    const tail = decoding.readTailAsUint8Array(decoder);
    if (tail.length > 0) {
      throw new Error(
        "Unexpected bytes at the end of the update, expected proper alignment of updates",
        {
          cause: { tail },
        },
      );
    }
  }

  return mergedUpdates! as UpdateMessage;
}
