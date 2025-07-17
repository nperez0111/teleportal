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
  MessageArray,
  decodeMessageArray,
  encodeMessageArray,
  ClientContext,
} from "teleportal";

export type FanOutReader<T> = {
  /**
   * Unsubscribe from further messages from the fan out writer
   */
  unsubscribe: () => void;
  /**
   * A readable stream to read messages from the fan out writer
   */
  readable: ReadableStream<T>;
};

/**
 * Creates a writer which will fan out to all connected readers.
 */
export function createFanOutWriter<T>() {
  const controllers: ReadableStreamDefaultController<T>[] = [];

  function getReader(): FanOutReader<T> {
    let controller: ReadableStreamDefaultController<T> | null = null;

    const readable = new ReadableStream<T>({
      start(ctrl) {
        controller = ctrl;
        controllers.push(ctrl);
      },
      cancel() {
        if (controller) {
          const index = controllers.indexOf(controller);
          if (index > -1) {
            controllers.splice(index, 1);
          }
        }
      },
    });

    return {
      unsubscribe: () => {
        if (controller) {
          const index = controllers.indexOf(controller);
          if (index > -1) {
            controllers.splice(index, 1);
          }
          try {
            controller.close();
          } catch {
            // Ignore if already closed
          }
        }
      },
      readable,
    };
  }

  const writable = new WritableStream<T>({
    write: async (message) => {
      // Send message to all active controllers
      controllers.forEach((controller) => {
        try {
          controller.enqueue(message);
        } catch {
          // Ignore if controller is closed
        }
      });
    },
    close: () => {
      controllers.forEach((controller) => {
        try {
          controller.close();
        } catch {
          // Ignore if already closed
        }
      });
      controllers.length = 0; // Clear the array
    },
    abort: (reason) => {
      controllers.forEach((controller) => {
        try {
          controller.error(reason);
        } catch {
          // Ignore if already closed
        }
      });
      controllers.length = 0; // Clear the array
    },
  });

  return {
    writable,
    getReader,
  };
}

export type FanInWriter<T> = {
  /**
   * Remove this writer from the fan in reader
   */
  unsubscribe: () => void;
  /**
   * A writable stream to write messages to the fan in reader
   */
  writable: WritableStream<T>;
};

/**
 * Creates a reader which will fan in from all connected writers.
 */
export function createFanInReader<T>() {
  let mainController: ReadableStreamDefaultController<T> | null = null;
  let isClosed = false;

  const writers: WritableStream<T>[] = [];

  const readable = new ReadableStream<T>({
    start(controller) {
      mainController = controller;
    },
    async cancel() {
      isClosed = true;
      // Just clear the writers array and let garbage collection handle cleanup
      await Promise.all(
        writers.map(async (writer) => {
          try {
            await writer.close();
          } catch {
            // Ignore if already closed
          }
        }),
      );
    },
  });

  function getWriter(): FanInWriter<T> {
    if (isClosed) {
      throw new Error("Cannot add writer to closed fan in reader");
    }

    const writable = new WritableStream<T>({
      write: async (chunk) => {
        if (mainController && !isClosed) {
          try {
            mainController.enqueue(chunk);
          } catch (error) {
            // Controller might be closed, ignore the error
          }
        }
      },
      close: () => {
        // Individual writer close doesn't close the main stream
      },
      abort: () => {
        // Individual writer abort doesn't close the main stream
      },
    });

    writers.push(writable);

    return {
      unsubscribe: () => {
        const index = writers.indexOf(writable);
        if (index > -1) {
          writers.splice(index, 1);
        }
        try {
          writable.abort();
        } catch {
          // Ignore if already closed
        }
      },
      writable,
    };
  }

  return {
    readable,
    getWriter,
    async close() {
      isClosed = true;
      try {
        mainController?.close();
      } catch {
        // Ignore if already closed
      }
      // Just clear the writers array and let garbage collection handle cleanup
      await Promise.all(
        writers.map(async (writer) => {
          try {
            await writer.close();
          } catch {
            // Ignore if already closed
          }
        }),
      );
    },
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
export const toMessageArrayStream = () =>
  new TransformStream<Message, MessageArray>({
    transform: (chunk, controller) => {
      const messageArray = encodeMessageArray([chunk]);
      controller.enqueue(messageArray);
    },
  });

export const fromMessageArrayStream = <Context extends ClientContext>(
  context: Context,
) =>
  new TransformStream<MessageArray, Message<Context>>({
    transform: (chunk, controller) => {
      for (const message of decodeMessageArray(chunk)) {
        if (context) {
          Object.assign(message.context, context);
        }
        controller.enqueue(message);
      }
    },
  });
