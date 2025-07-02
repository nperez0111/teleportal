import * as encoding from "lib0/encoding";
import type { BinaryMessage } from "./message-types";

/**
 * Checks if a message is a ping message.
 */
export function isPingMessage(message: BinaryMessage): boolean {
  return (
    // Y
    message[0] === 0x59 &&
    // J
    message[1] === 0x4a &&
    // S
    message[2] === 0x53 &&
    // p
    message[3] === 0x70 &&
    // i
    message[4] === 0x69 &&
    // n
    message[5] === 0x6e &&
    // g
    message[6] === 0x67
  );
}

/**
 * Checks if a message is a pong message.
 */
export function isPongMessage(message: BinaryMessage): boolean {
  return (
    // Y
    message[0] === 0x59 &&
    // J
    message[1] === 0x4a &&
    // S
    message[2] === 0x53 &&
    // p
    message[3] === 0x70 &&
    // o
    message[4] === 0x6f &&
    // n
    message[5] === 0x6e &&
    // g
    message[6] === 0x67
  );
}

/**
 * Encodes a ping message.
 */
export function encodePingMessage(): BinaryMessage {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, 0x59);
  encoding.writeUint8(encoder, 0x4a);
  encoding.writeUint8(encoder, 0x53);
  encoding.writeUint8(encoder, 0x70);
  encoding.writeUint8(encoder, 0x69);
  encoding.writeUint8(encoder, 0x6e);
  encoding.writeUint8(encoder, 0x67);
  return encoding.toUint8Array(encoder) as BinaryMessage;
}

/**
 * Encodes a pong message.
 */
export function encodePongMessage(): BinaryMessage {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, 0x59);
  encoding.writeUint8(encoder, 0x4a);
  encoding.writeUint8(encoder, 0x53);
  encoding.writeUint8(encoder, 0x70);
  encoding.writeUint8(encoder, 0x6f);
  encoding.writeUint8(encoder, 0x6e);
  encoding.writeUint8(encoder, 0x67);
  return encoding.toUint8Array(encoder) as BinaryMessage;
}
