import type { ReceivedMessage } from "./protocol";

export type ClientContext = {
  /**
   * An identifier for the client. Assigned by the server.
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
} & ClientContext;

/**
 * A Y.js document update.
 */
export type YDocUpdate<Context extends Record<string, unknown>> =
  ReceivedMessage<Context> & {
    type: "doc";
  };

/**
 * A Y.js awareness update.
 */
export type YAwarenessUpdate<Context extends Record<string, unknown>> =
  ReceivedMessage<Context> & {
    type: "awareness";
  };

/**
 * A source of Y.js updates.
 */
export type YSource<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
> = {
  /**
   * A readable stream of document/awareness updates.
   */
  readable: ReadableStream<ReceivedMessage<Context>>;
} & AdditionalProperties;

/**
 * A sink of Y.js updates.
 */
export type YSink<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
> = {
  /**
   * A writable stream of document updates.
   */
  writable: WritableStream<ReceivedMessage<Context>>;
} & AdditionalProperties;

/**
 * A pair of a {@link YSource} and a {@link YSink}, which can both read and write updates.
 */
export type YTransport<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
> = YSink<Context, AdditionalProperties> &
  YSource<Context, AdditionalProperties>;

/**
 * Compose a {@link YSource} and {@link YSink} into a {@link YTransport}.
 */
export function compose<
  Context extends Record<string, unknown>,
  SourceAdditionalProperties extends Record<string, unknown>,
  SinkAdditionalProperties extends Record<string, unknown>,
>(
  source: YSource<Context, SourceAdditionalProperties>,
  sink: YSink<Context, SinkAdditionalProperties>,
): YTransport<Context, SourceAdditionalProperties & SinkAdditionalProperties> {
  return {
    ...source,
    ...sink,
    readable: source.readable,
    writable: sink.writable,
  };
}

/**
 * Pipe the updates from a {@link YSource} to a {@link YSink}.
 */
export function pipe<Context extends Record<string, unknown>>(
  source: YSource<Context, any>,
  sink: YSink<Context, any>,
): Promise<void> {
  return source.readable.pipeTo(sink.writable);
}

/**
 * Sync two {@link YTransport}s.
 */
export function sync<Context extends Record<string, unknown>>(
  a: YTransport<Context, any>,
  b: YTransport<Context, any>,
): Promise<void> {
  return Promise.all([pipe(a, b), pipe(b, a)]).then(() => undefined);
}
