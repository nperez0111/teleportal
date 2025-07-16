import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { decodeMessage } from "./decode";
import { BinaryMessage, Message, RawReceivedMessage } from "./message-types";
import { Tag } from "./types";

/**
 * An array of messages encoded into a single binary message
 */
export type MessageArray = Tag<Uint8Array, "message-array">;

/**
 * Encodes a list of {@link Message}s into a single {@link MessageArray} as binary
 */
export function encodeMessageArray(messages: Message[]): MessageArray {
  return encoding.encode((encoder) => {
    for (const message of messages) {
      encoding.writeVarUint8Array(encoder, message.encoded);
    }
  }) as MessageArray;
}

/**
 * Decodes a {@link MessageArray} into a list of {@link RawReceivedMessage} messages
 */
export function decodeMessageArray(buffer: MessageArray): RawReceivedMessage[] {
  const decoder = decoding.createDecoder(buffer);
  const messages: RawReceivedMessage[] = [];

  while (decoder.pos < decoder.arr.length) {
    const encoded = decoding.readVarUint8Array(decoder);
    messages.push(decodeMessage(encoded as BinaryMessage));
  }
  return messages;
}
