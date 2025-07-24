import {
  type Message,
  type Sink,
  type Source,
  type Transport,
} from "teleportal";
import { compose } from "teleportal/transports";

/**
 * A {@link Sink} that wraps another sink and passes all updates through, only allowing messages that are authorized.
 */
export function withMessageValidatorSink<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  sink: Sink<Context, AdditionalProperties>,
  options?: {
    isAuthorized?: (
      chunk: Message<Context>,
      type: "read" | "write",
    ) => Promise<boolean>;
  },
): Sink<Context, AdditionalProperties> {
  return {
    ...sink,
    writable: new WritableStream({
      async write(chunk) {
        if (!(await options?.isAuthorized?.(chunk, "write"))) {
          return;
        }

        const writer = sink.writable.getWriter();
        try {
          await writer.ready;
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
 * A {@link Source} that wraps another source and passes all updates through, only allowing messages that are authorized.
 */
export function withMessageValidatorSource<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  source: Source<Context, AdditionalProperties>,
  options?: {
    isAuthorized?: (
      chunk: Message<Context>,
      type: "read" | "write",
    ) => Promise<boolean>;
  },
): Source<Context, AdditionalProperties> {
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
  transport: Transport<Context, AdditionalProperties>,
  options?: {
    isAuthorized?: (
      chunk: Message<Context>,
      type: "read" | "write",
    ) => Promise<boolean>;
  },
): Transport<Context, AdditionalProperties> {
  return compose(
    withMessageValidatorSource(transport, options),
    withMessageValidatorSink(transport, options),
  );
}
