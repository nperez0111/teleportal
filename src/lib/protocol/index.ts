/**
 * Binary encoding of the teleportal protocol.
 *
 * The wire format (version 1) is:
 * - 3 bytes: magic number "YJS" (0x59, 0x4a, 0x53)
 * - 1 byte: version (0x01)
 * - varString: document name
 * - 1 byte: encrypted flag (0 or 1)
 * - 1 byte: message type (0=doc, 1=awareness, 2=ack, 3=presence, 4=rpc)
 * - type-specific payload
 */

export * from "./decode";
export * from "./encode";
export * from "./file-transfer";
export * from "./message-types";
export * from "./milestone";
export * from "./multi-message";
export * from "./ping";
export * from "./pubSub";
export * from "./types";
export * from "./utils";
