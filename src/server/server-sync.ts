import type { Observable, ServerContext, Transport } from "teleportal";

/**
 * Interface for server sync transport that can handle multiple documents
 */
export type ServerSyncTransport<
  Context extends ServerContext,
  AdditionalProperties extends Record<string, unknown> = Record<
    string,
    unknown
  >,
> = Transport<
  Context,
  {
    // TODO will probably switch to hookable here, but want the types to be better first
    /**
     * The observer to use for the transport
     */
    observer?: Observable<{
      /**
       * Subscribe to updates for a specific document
       */
      subscribe: (documentId: string) => void;
      /**
       * Unsubscribe from updates for a specific document
       */
      unsubscribe: (documentId: string) => void;
    }>;
    /**
     * Close the transport and clean up resources
     */
    close?: () => Promise<void>;
  } & AdditionalProperties
>;

/**
 * No-op implementation that does nothing
 */
export function createNoopServerSyncTransport<
  Context extends ServerContext,
>(): ServerSyncTransport<Context> {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
  };
}
