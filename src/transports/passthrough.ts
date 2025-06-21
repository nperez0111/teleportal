import {
  compose,
  type Message,
  type YSink,
  type YSource,
  type YTransport,
} from "match-maker";

/**
 * A {@link YSink} that wraps another sink and passes all updates through.
 */
export function withPassthroughSink<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  sink: YSink<Context, AdditionalProperties>,
  options?: {
    onWrite?: (chunk: Message<Context>) => void;
  },
): YSink<Context, AdditionalProperties> {
  return {
    ...sink,
    writable: new WritableStream({
      async write(chunk) {
        options?.onWrite?.(chunk);

        const writer = sink.writable.getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
      },
      close: sink.writable.close,
      abort: sink.writable.abort,
    }),
  };
}

/**
 * A {@link YSource} that wraps another source and passes all updates through.
 */
export function withPassthroughSource<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  source: YSource<Context, AdditionalProperties>,
  options?: {
    onRead?: (chunk: Message<Context>) => void;
  },
): YSource<Context, AdditionalProperties> {
  return {
    ...source,
    readable: source.readable.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          options?.onRead?.(chunk);
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
  transport: YTransport<Context, AdditionalProperties>,
  options?: {
    onRead?: (chunk: Message<Context>) => void;
    onWrite?: (chunk: Message<Context>) => void;
  },
): YTransport<Context, AdditionalProperties> {
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
>(): YTransport<Context, {}> {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
  };
}
