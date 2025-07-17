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

export type ReaderInstance = {
  /**
   * Unsubscribe from further messages from the fan out writer
   */
  unsubscribe: () => void;
  /**
   * A readable stream to read messages from the fan out writer
   */
  readable: ReadableStream<BinaryMessage>;
};

export type WriterInstance = {
  /**
   * Remove this writer from the fan in reader
   */
  remove: () => void;
  /**
   * A writable stream to write messages to the fan in reader
   */
  writable: WritableStream<BinaryMessage>;
};

/**
 * Creates a writer which will fan out to all connected readers.
 */
export function createFanOutWriter() {
  const transports: TransformStream<BinaryMessage, BinaryMessage>[] = [];

  const writable = new WritableStream<BinaryMessage>({
    write: async (message) => {
      await Promise.all(
        transports.map(async (transport) => {
          const writer = transport.writable.getWriter();
          await writer.write(message);
          writer.releaseLock();
        }),
      );
    },
    close: () => {
      transports.forEach((transport) => {
        transport.writable.close();
      });
    },
    abort: (reason) => {
      transports.forEach((transport) => {
        transport.writable.abort(reason);
      });
    },
  });

  function getReader(): ReaderInstance {
    const transform = new TransformStream<BinaryMessage, BinaryMessage>();

    transports.push(transform);

    return {
      unsubscribe: () => {
        const index = transports.indexOf(transform);
        if (index > -1) {
          transports.splice(index, 1);
        }
      },
      readable: transform.readable,
    };
  }

  return {
    writer: writable.getWriter(),
    getReader,
  };
}

/**
 * Creates a reader which will fan in from all connected writers.
 */
export function createFanInReader() {
  const controllers: ReadableStreamDefaultController<BinaryMessage>[] = [];

  const writers: { transform: TransformStream<BinaryMessage, BinaryMessage>; writable: WritableStream<BinaryMessage> }[] = [];

  const readable = new ReadableStream<BinaryMessage>({
    start(controller) {
      controllers.push(controller);
    },
    cancel() {
      controllers.forEach((controller) => {
        try {
          controller.close();
        } catch {
          // Ignore if already closed
        }
      });
      writers.forEach((writer) => {
        try {
          writer.writable.close();
        } catch {
          // Ignore if already closed
        }
      });
    },
  });

  function getWriter(): WriterInstance {
    const transform = new TransformStream<BinaryMessage, BinaryMessage>({
      transform(chunk, controller) {
        // Forward the message to all readable stream controllers
        controllers.forEach((ctrl) => {
          try {
            ctrl.enqueue(chunk);
          } catch (error) {
            // Controller might be closed, ignore the error
          }
        });
        controller.enqueue(chunk);
      },
    });

    const writerEntry = {
      transform,
      writable: transform.writable,
    };

    writers.push(writerEntry);

    return {
      remove: () => {
        const index = writers.indexOf(writerEntry);
        if (index > -1) {
          writers.splice(index, 1);
        }
        try {
          writerEntry.writable.close();
        } catch {
          // Ignore if already closed
        }
      },
      writable: writerEntry.writable,
    };
  }

  return {
    readable,
    getWriter
  };
}

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
} /**
 * Pipe the updates from a {@link Source} to a {@link Sink}.
 */

export function pipe<Context extends Record<string, unknown>>(
  source: Source<Context>,
  sink: Sink<Context>,
): Promise<void> {
  return source.readable.pipeTo(sink.writable);
} /**
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
  }); /**
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
