import { type BinaryMessage, type Message } from "./protocol";

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

/**
 * Generic interface for a pub/sub backend implementation.
 * Can be implemented by in-memory queues, Redis, or any other pub/sub system.
 */
export interface PubSub {
  /**
   * Publish a message to a topic/channel
   */
  publish(
    topic: PubSubTopic,
    message: BinaryMessage,
    /**
     * Optional source ID to identify the source of the message.
     * If not provided, the message is published to all subscribers.
     */
    sourceId: string,
  ): Promise<void>;

  /**
   * Subscribe to a topic/channel and receive messages
   * @param topic - The topic to subscribe to
   * @param callback - Function called when a message is received
   * @returns A function to unsubscribe
   */
  subscribe(
    topic: PubSubTopic,
    callback: (
      message: BinaryMessage,
      /**
       * The source ID of the message.
       */
      sourceId: string,
    ) => void,
  ): Promise<() => Promise<void>>;

  /**
   * Shutdown the backend
   */
  destroy?: () => Promise<void>;
}

/**
 * The types of topics that can be used with the pub/sub backend.
 */
export type PubSubTopicTypes = {
  document: `document/${string}`;
  client: `client/${string}`;
};

/**
 * A topic for a pub/sub backend.
 */
export type PubSubTopic = PubSubTopicTypes[keyof PubSubTopicTypes];
