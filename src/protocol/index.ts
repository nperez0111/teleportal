/**
 * Binary encoding of the match-maker protocol.
 *
 * The format (version 1) is as follows:
 * - 3 bytes: magic number "YJS" (0x59, 0x4a, 0x53)
 * - 1 byte: version (currently only 0x01 is supported)
 * - 1 byte: length of document name
 * - document name: the name of the document
 * - yjs base protocol (type + data payload)
 */

export * from "./decode";
export * from "./encode";
export * from "./message-types";
export * from "./ping";
export * from "./types";
export * from "./utils";
export * from "./snapshot-examples";
