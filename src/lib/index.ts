import { type BinaryMessage, type Message } from "./protocol";

/**
 * Binary encoding of the teleportal protocol.
 *
 * The format (version 1) is as follows:
 * - 3 bytes: magic number "YJS" (0x59, 0x4a, 0x53)
 * - 1 byte: version (currently only 0x01 is supported)
 * - 1 byte: length of document name
 * - document name: the name of the document
 * - yjs base protocol (type + data payload)
 */
export * from "./protocol";
export * from "./utils";

export type ClientContext = {
  /**
   * An identifier for the client. Assigned on the server.
   */
  clientId: string;
};

export type ServerContext = {
  /**
   * An identifier for the user. Assigned by the server.
   */
  userId: string;
  /**
   * The room the user is in (e.g. organization, project, etc.). Assigned by the server.
   *
   * This segments the document further, allowing multiple contexts to re-use document names.
   */
  room: string;
  /**
   * An identifier for the client. Assigned on the server.
   */
  clientId: string;
};

/**
 * A source of Y.js updates.
 */
export type Source<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown> = Record<
    string,
    unknown
  >,
> = {
  /**
   * A readable stream of document/awareness updates.
   */
  readable: ReadableStream<Message<Context>>;
} & AdditionalProperties;

/**
 * A sink of Y.js updates.
 */
export type Sink<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown> = Record<
    string,
    unknown
  >,
> = {
  /**
   * A writable stream of document updates.
   */
  writable: WritableStream<Message<Context>>;
} & AdditionalProperties;

/**
 * A pair of a {@link Source} and a {@link Sink}, which can both read and write updates.
 */
export type Transport<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown> = Record<
    string,
    unknown
  >,
> = Sink<Context, AdditionalProperties> & Source<Context, AdditionalProperties>;

/**
 * A transport which sends and receives Y.js binary messages.
 */
export type BinaryTransport<
  AdditionalProperties extends Record<string, unknown> = {},
> = {
  /**
   * Reads bytes
   */
  readable: ReadableStream<BinaryMessage>;
  /**
   * Sends bytes
   */
  writable: WritableStream<BinaryMessage>;
} & AdditionalProperties;
