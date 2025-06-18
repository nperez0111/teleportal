import type { BinaryMessage } from "../../lib";

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
        transform.writable.close();
      },
      readable: transform.readable,
    };
  }

  return {
    writable,
    getReader,
  };
}
