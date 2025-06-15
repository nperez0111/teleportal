import type { BinaryMessage } from "../lib";

export type ReaderInstance = {
  unsubscribe: () => void;
  readable: ReadableStream<BinaryMessage>;
};

export function createMultiReader() {
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
        transform.readable.cancel();
        const index = transports.indexOf(transform);
        if (index > -1) {
          transports.splice(index, 1);
        }
      },
      readable: transform.readable,
    };
  }

  return {
    writable,
    getReader,
  };
}
