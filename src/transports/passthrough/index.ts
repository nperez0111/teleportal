import {
  type Message,
  type Sink,
  type Source,
  type Transport,
} from "teleportal";
import { compose } from "teleportal/transports";

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
  const writer = sink.writable.getWriter();

  return {
    ...sink,
    writable: new WritableStream({
      async write(chunk) {
        if (options?.onWrite?.(chunk) === false) {
          return;
        }

        await writer.write(chunk);
      },
      close: sink.writable.close,
      abort: sink.writable.abort,
    }),
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
  return {
    ...source,
    readable: source.readable.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (options?.onRead?.(chunk) === false) {
            return;
          }

          controller.enqueue(chunk);
        },
      }),
    ),
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
export function noopTransport<
  Context extends Record<string, unknown>,
>(): Transport<Context> {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
  };
}
