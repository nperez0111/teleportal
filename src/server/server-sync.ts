import type { ServerContext, YTransport } from "teleportal";

/**
 * Interface for server sync transport that can handle multiple documents
 */
export type ServerSyncTransport<Context extends ServerContext> = YTransport<
  Context,
  {
    /**
     * Subscribe to updates for a specific document
     */
    subscribe?: (documentId: string) => Promise<void>;

    /**
     * Unsubscribe from updates for a specific document
     */
    unsubscribe?: (documentId: string) => Promise<void>;

    /**
     * Close the transport and clean up resources
     */
    close?: () => Promise<void>;
  }
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
