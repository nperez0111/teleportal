import { compose, YSink, YSource, type YTransport } from "../base";
import { ReceivedMessage } from "../protocol";

/**
 * A {@link YSink} that wraps another sink and passes all updates through.
 */
export function passthroughSink<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  sink: YSink<Context, AdditionalProperties>,
  options?: {
    onWrite?: (chunk: ReceivedMessage<Context>) => void;
  },
): YSink<Context, AdditionalProperties> {
  const writer = sink.writable.getWriter();

  return {
    ...sink,
    writable: new WritableStream({
      write(chunk) {
        options?.onWrite?.(chunk);
        writer.write(chunk);
      },
      close() {
        writer.close();
      },
    }),
  };
}

/**
 * A {@link YSource} that wraps another source and passes all updates through.
 */
export function passthroughSource<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  source: YSource<Context, AdditionalProperties>,
  options?: {
    onRead?: (chunk: ReceivedMessage<Context>) => void;
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
export function passthrough<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: YTransport<Context, AdditionalProperties>,
  options?: {
    onRead?: (chunk: ReceivedMessage<Context>) => void;
    onWrite?: (chunk: ReceivedMessage<Context>) => void;
  },
): YTransport<Context, AdditionalProperties> {
  return compose(
    passthroughSource(transport, options),
    passthroughSink(transport, options),
  );
}

/**
 * A transport that does nothing.
 */
export function noop<Context extends Record<string, unknown>>(): YTransport<
  Context,
  {}
> {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
  };
}
