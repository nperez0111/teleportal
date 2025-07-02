import {
  type BinaryMessage,
  decodeMessage,
  encodePongMessage,
  isPingMessage,
  type Message,
} from "teleportal/protocol";
export * from "teleportal/protocol";

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
} & ClientContext;

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
  readable: ReadableStream<Message<Context>>;
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
  writable: WritableStream<Message<Context>>;
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

/**
 * Reads an untrusted {@link BinaryMessage} and decodes it into a {@link Message}.
 */
export const getMessageReader = <Context extends Record<string, unknown>>(
  context: Context,
) =>
  new TransformStream<BinaryMessage, Message<Context>>({
    transform(chunk, controller) {
      const decoded = decodeMessage(chunk);
      Object.assign(decoded.context, context);
      controller.enqueue(decoded as Message<Context>);
    },
  });

/**
 * A transport which sends and receives Y.js binary messages.
 */
export type YBinaryTransport<
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
 * Convert a {@link YTransport} to a {@link YBinaryTransport}.
 *
 * This will encode all messages going in and out of the transport from {@link BinaryMessage} to {@link Message} and vice versa.
 */
export function toBinaryTransport<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: YTransport<Context, AdditionalProperties>,
  context: Context,
): YBinaryTransport<AdditionalProperties> {
  const reader = getMessageReader(context);
  const writer = new TransformStream<Message, BinaryMessage>({
    transform(chunk, controller) {
      controller.enqueue(chunk.encoded);
    },
  });
  const binarySource: YSource<Context, any> = { readable: reader.readable };
  const binarySink: YSink<Context, any> = { writable: writer.writable };
  const binaryTransport = compose(binarySource, binarySink);

  sync(binaryTransport, transport);
  return {
    ...transport,
    readable: writer.readable,
    writable: reader.writable,
  };
}

export function fromBinaryTransport<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: YBinaryTransport<AdditionalProperties>,
  context: Context,
): YTransport<Context, AdditionalProperties> {
  const readable = transport.readable
    .pipeThrough(
      new TransformStream({
        async transform(chunk, controller) {
          // Just filter out ping messages to avoid any unnecessary processing
          if (isPingMessage(chunk)) {
            const writer = transport.writable.getWriter();
            try {
              await writer.write(encodePongMessage());
            } finally {
              writer.releaseLock();
            }
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    )
    .pipeThrough(getMessageReader(context));

  const writable = new WritableStream<Message>({
    async write(chunk) {
      const writer = transport.writable.getWriter();
      try {
        await writer.write(chunk.encoded);
      } finally {
        writer.releaseLock();
      }
    },
    close: transport.writable.close,
    abort: transport.writable.abort,
  });

  return {
    ...transport,
    readable,
    writable,
  };
}
