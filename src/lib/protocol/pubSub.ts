import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { BinaryMessage } from "./message-types";

export function encodePubSubMessage(message: BinaryMessage, sourceId: string) {
  return encoding.encode((encoder) => {
    encoding.writeVarString(encoder, sourceId);
    encoding.writeUint8Array(encoder, message);
  });
}

export function decodePubSubMessage(message: Uint8Array) {
  const decoder = decoding.createDecoder(message);

  const sourceId = decoding.readVarString(decoder);
  const decodedMessage = decoding.readTailAsUint8Array(
    decoder,
  ) as BinaryMessage;

  return {
    sourceId,
    message: decodedMessage,
  };
}
