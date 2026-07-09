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
  AdditionalProperties extends Record<string, unknown> = {},
> = {
  /**
   * An async iterable of document/awareness updates.
   */
  source: AsyncIterable<Message<Context>[]>;
} & AdditionalProperties;

/**
 * A sink of Y.js updates.
 */
export type Sink<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown> = {},
> = {
  /**
   * Writes a document update.
   */
  write(message: Message<Context>): void | Promise<void>;
  close(): void;
} & AdditionalProperties;

/**
 * A pair of a {@link Source} and a {@link Sink}, which can both read and write updates.
 */
export type Transport<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown> = {},
> = Source<Context, AdditionalProperties> & Sink<Context, AdditionalProperties>;

/**
 * A transport which sends and receives Y.js binary messages.
 */
export type BinaryTransport<AdditionalProperties extends Record<string, unknown> = {}> = {
  /**
   * Reads bytes
   */
  source: AsyncIterable<BinaryMessage[]>;
  /**
   * Sends bytes
   */
  write(message: BinaryMessage): void | Promise<void>;
  close(): void;
} & AdditionalProperties;

/**
 * Options for {@link PubSub.publish}.
 */
export interface PublishOptions {
  /**
   * Ephemeral messages (presence/awareness/ack) skip the durable log and travel over the
   * backend's plain fire-and-forget channel. Plain (non-durable) backends ignore this flag —
   * everything is fire-and-forget for them anyway.
   */
  ephemeral?: boolean;
}

/**
 * Options for {@link PubSub.subscribe}.
 */
export interface SubscribeOptions {
  /**
   * Called when the backend knows messages may have been missed and cannot replay them
   * (e.g. the resume position was trimmed out of a durable log's retention window). The
   * consumer is expected to heal out-of-band (Teleportal re-syncs from storage).
   *
   * Plain (non-durable) backends never call it.
   */
  onGap?: (topic: PubSubTopic) => void;
}

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
    options?: PublishOptions,
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
    options?: SubscribeOptions,
  ): Promise<() => Promise<void>>;

  /**
   * Shutdown the backend
   */
  [Symbol.asyncDispose]?: () => Promise<void>;
}

/**
 * An opaque, backend-specific position in a durable log (a Redis Stream entry id, a JetStream
 * stream sequence, an in-memory counter). Only meaningful to the backend that produced it.
 */
export type PubSubOffset = string;

/**
 * Options for {@link DurablePubSub.subscribeDurable}.
 */
export interface DurableSubscribeOptions extends SubscribeOptions {
  /**
   * Where to start delivering from:
   * - `"new"` (default): live messages only — same as plain {@link PubSub.subscribe}.
   * - `{ after }`: replay everything after that offset, then continue live. If `after` was
   *   trimmed from retention, replay starts at the oldest retained entry and {@link
   *   SubscribeOptions.onGap} fires.
   */
  start?: "new" | { after: PubSubOffset };
}

/**
 * Optional durable capability of a {@link PubSub} backend.
 *
 * @experimental No part of Teleportal's core calls {@link subscribeDurable} — the core relies
 * only on a durable backend's internal read loop resuming after a transport blip via plain
 * {@link PubSub.subscribe}. This surface exists for external replay consumers (cross-restart
 * resume, tailing) and its shape may change.
 */
export interface DurablePubSub extends PubSub {
  readonly durable: true;
  /**
   * Subscribe with replay support. Fans in two sources into one callback: the durable stream
   * (offset defined) and the plain ephemeral channel (offset `undefined`).
   */
  subscribeDurable(
    topic: PubSubTopic,
    callback: (message: BinaryMessage, sourceId: string, offset: PubSubOffset | undefined) => void,
    options?: DurableSubscribeOptions,
  ): Promise<() => Promise<void>>;
}

/**
 * Narrow a {@link PubSub} to {@link DurablePubSub} when it advertises durability.
 */
export function isDurablePubSub(pubSub: PubSub): pubSub is DurablePubSub {
  return (pubSub as Partial<DurablePubSub>).durable === true;
}

/**
 * The types of topics that can be used with the pub/sub backend.
 */
export type PubSubTopicTypes = {
  document: `document/${string}`;
  client: `client/${string}`;
  ack: `ack/${string}`;
};

/**
 * A topic for a pub/sub backend.
 */
export type PubSubTopic = PubSubTopicTypes[keyof PubSubTopicTypes];
