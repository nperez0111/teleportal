import { type Message, type Sink, type Source, type Transport } from "teleportal";
import { compose, createChannel, filterMessages } from "teleportal/transports";

/**
 * A {@link Sink} that wraps another sink and passes all updates through.
 */
export function withPassthroughSink<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  sink: Sink<Context, AdditionalProperties>,
  options?: {
    onWrite?: (chunk: Message<Context>) => boolean | void;
  },
): Sink<Context, AdditionalProperties> {
  return {
    ...sink,
    write(message: Message<Context>) {
      if (options?.onWrite?.(message) === false) {
        return;
      }
      return sink.write(message);
    },
  };
}

/**
 * A {@link Source} that wraps another source and passes all updates through.
 */
export function withPassthroughSource<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  source: Source<Context, AdditionalProperties>,
  options?: {
    onRead?: (chunk: Message<Context>) => boolean | void;
  },
): Source<Context, AdditionalProperties> {
  if (!options?.onRead) return source;
  const { onRead } = options;
  return {
    ...source,
    source: filterMessages<Message<Context>>((msg) => onRead(msg) !== false)(source.source),
  };
}

/**
 * A transport that wraps another transport and passes all updates through.
 *
 * @param transport - The transport to wrap.
 * @returns The wrapped transport.
 */
export function withPassthrough<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: Transport<Context, AdditionalProperties>,
  options?: {
    onRead?: (chunk: Message<Context>) => boolean | void;
    onWrite?: (chunk: Message<Context>) => boolean | void;
  },
): Transport<Context, AdditionalProperties> {
  return compose(
    withPassthroughSource(transport, options),
    withPassthroughSink(transport, options),
  );
}

/**
 * A transport that does nothing.
 */
export function noopTransport<Context extends Record<string, unknown>>(): Transport<Context> {
  const channel = createChannel<Message<Context>>();
  channel.close();
  return {
    source: channel,
    write() {},
    close() {
      channel.close();
    },
  };
}
