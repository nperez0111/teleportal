import {
  compose,
  type Message,
  type YSink,
  type YSource,
  type YTransport,
} from "teleportal";

/**
 * A {@link YSink} that wraps another sink and passes all updates through, only allowing messages that are authorized.
 */
export function withMessageValidatorSink<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  sink: YSink<Context, AdditionalProperties>,
  options?: {
    isAuthorized?: (
      chunk: Message<Context>,
      type: "read" | "write",
    ) => Promise<boolean>;
  },
): YSink<Context, AdditionalProperties> {
  return {
    ...sink,
    writable: new WritableStream({
      async write(chunk) {
        if (!(await options?.isAuthorized?.(chunk, "write"))) {
          return;
        }

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
 * A {@link YSource} that wraps another source and passes all updates through, only allowing messages that are authorized.
 */
export function withMessageValidatorSource<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  source: YSource<Context, AdditionalProperties>,
  options?: {
    isAuthorized?: (
      chunk: Message<Context>,
      type: "read" | "write",
    ) => Promise<boolean>;
  },
): YSource<Context, AdditionalProperties> {
  return {
    ...source,
    readable: source.readable.pipeThrough(
      new TransformStream({
        async transform(chunk, controller) {
          if (!(await options?.isAuthorized?.(chunk, "read"))) {
            return;
          }

          controller.enqueue(chunk);
        },
      }),
    ),
  };
}

/**
 * A transport that wraps another transport and passes all updates through, only allowing messages that are authorized.
 *
 * @param transport - The transport to wrap.
 * @returns The wrapped transport.
 */
export function withMessageValidator<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: YTransport<Context, AdditionalProperties>,
  options?: {
    isAuthorized?: (
      chunk: Message<Context>,
      type: "read" | "write",
    ) => Promise<boolean>;
  },
): YTransport<Context, AdditionalProperties> {
  return compose(
    withMessageValidatorSource(transport, options),
    withMessageValidatorSink(transport, options),
  );
}
