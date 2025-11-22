type ErrorLike = Error & {
  code?: string | number;
  cause?: unknown;
};

/**
 * Convert unknown errors into structured metadata suitable for LogTape.
 */
export function toErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const err = error as ErrorLike;
    const details: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };

    if (err.stack) {
      details.stack = err.stack;
    }

    if (err.code !== undefined) {
      details.code = err.code;
    }

    if (err.cause !== undefined) {
      details.cause =
        err.cause instanceof Error ? toErrorDetails(err.cause) : err.cause;
    }

    return details;
  }

  return { value: error };
}
