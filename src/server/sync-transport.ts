import type { Message, ServerContext } from "teleportal";

/**
 * Abstract interface for server synchronization transport.
 * This allows different server instances to communicate and synchronize state.
 */
export interface ServerSyncTransport<Context extends ServerContext> {
  /**
   * Subscribe to updates for a specific document
   */
  subscribe(documentId: string, onMessage: (message: Message<Context>) => void): Promise<void>;
  
  /**
   * Unsubscribe from updates for a specific document
   */
  unsubscribe(documentId: string): Promise<void>;
  
  /**
   * Publish an update to other server instances for a specific document
   */
  publish(documentId: string, message: Message<Context>): Promise<void>;
  
  /**
   * Close the transport and clean up resources
   */
  close(): Promise<void>;
}

/**
 * No-op implementation that does nothing.
 * Used when no server synchronization is needed.
 */
export class NoopSyncTransport<Context extends ServerContext> implements ServerSyncTransport<Context> {
  async subscribe(documentId: string, onMessage: (message: Message<Context>) => void): Promise<void> {
    // No-op
  }
  
  async unsubscribe(documentId: string): Promise<void> {
    // No-op
  }
  
  async publish(documentId: string, message: Message<Context>): Promise<void> {
    // No-op
  }
  
  async close(): Promise<void> {
    // No-op
  }
}