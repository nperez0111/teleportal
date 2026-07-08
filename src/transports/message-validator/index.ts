import { type Message, type Sink, type Source, type Transport } from "teleportal";
import { compose, filterMessages } from "teleportal/transports";

/**
 * A {@link Sink} that wraps another sink and passes all updates through, only allowing messages that are authorized.
 */
export function withMessageValidatorSink<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  sink: Sink<Context, AdditionalProperties>,
  options?: {
    isAuthorized?: (chunk: Message<Context>, type: "read" | "write") => Promise<boolean>;
  },
): Sink<Context, AdditionalProperties> {
  return {
    ...sink,
    async write(message: Message<Context>) {
      if (options?.isAuthorized && !(await options.isAuthorized(message, "write"))) {
        return;
      }
      return sink.write(message);
    },
    // Explicit delegation: spreading a class-based sink would lose its
    // prototype `close` method.
    close: () => sink.close(),
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
    isAuthorized?: (chunk: Message<Context>, type: "read" | "write") => Promise<boolean>;
  },
): Source<Context, AdditionalProperties> {
  if (!options?.isAuthorized) return source;
  const { isAuthorized } = options;
  return {
    ...source,
    source: filterMessages<Message<Context>>((msg) => isAuthorized(msg, "write"))(source.source),
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
    isAuthorized?: (chunk: Message<Context>, type: "read" | "write") => Promise<boolean>;
  },
): Transport<Context, AdditionalProperties> {
  return compose(
    withMessageValidatorSource(transport, options),
    withMessageValidatorSink(transport, options),
  );
}
