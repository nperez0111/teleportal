import {
  Source,
  Sink,
  Transport,
  decodeMessage,
  type BinaryMessage,
  type Message,
  BinaryTransport,
  encodePongMessage,
  isPingMessage,
} from "teleportal";

/**
 * Compose a {@link Source} and {@link Sink} into a {@link Transport}.
 */
export function compose<
  Context extends Record<string, unknown>,
  SourceAdditionalProperties extends Record<string, unknown>,
  SinkAdditionalProperties extends Record<string, unknown>,
>(
  source: Source<Context, SourceAdditionalProperties>,
  sink: Sink<Context, SinkAdditionalProperties>,
): Transport<Context, SourceAdditionalProperties & SinkAdditionalProperties> {
  return {
    ...source,
    ...sink,
    readable: source.readable,
    writable: sink.writable,
  };
}

/**
 * Pipe the updates from a {@link Source} to a {@link Sink}.
 */
export function pipe<Context extends Record<string, unknown>>(
  source: Source<Context>,
  sink: Sink<Context>,
): Promise<void> {
  return source.readable.pipeTo(sink.writable);
}

/**
 * Sync two {@link Transport}s.
 */
export function sync<Context extends Record<string, unknown>>(
  a: Transport<Context>,
  b: Transport<Context>,
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
 * Convert a {@link Transport} to a {@link BinaryTransport}.
 *
 * This will encode all messages going in and out of the transport from {@link BinaryMessage} to {@link Message} and vice versa.
 */
export function toBinaryTransport<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: Transport<Context, AdditionalProperties>,
  context: Context,
): BinaryTransport<AdditionalProperties> {
  const reader = getMessageReader(context);
  const writer = new TransformStream<Message, BinaryMessage>({
    transform(chunk, controller) {
      controller.enqueue(chunk.encoded);
    },
  });
  const binarySource: Source<Context> = { readable: reader.readable };
  const binarySink: Sink<Context> = { writable: writer.writable };
  const binaryTransport = compose(binarySource, binarySink);

  sync(binaryTransport, transport);
  return {
    ...transport,
    readable: writer.readable,
    writable: reader.writable,
  };
}

/**
 * Convert a {@link BinaryTransport} to a {@link Transport}.
 *
 * This will decode all messages going in and out of the transport from {@link BinaryMessage} to {@link Message} and vice versa.
 */
export function fromBinaryTransport<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: BinaryTransport<AdditionalProperties>,
  context: Context,
): Transport<Context, AdditionalProperties> {
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
