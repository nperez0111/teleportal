import type { Message, ServerContext } from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import type { Logger } from "teleportal/server";

/**
 * Replicator interface for cross-node message fanout.
 */
export interface Replicator {
  /**
   * Subscribe to a document channel and receive decoded messages.
   * Returns an async unsubscribe function.
   */
  subscribe(
    documentId: string,
    onMessage: (message: Message<any>) => Promise<void> | void,
  ): Promise<() => Promise<void>>;

  /**
   * Publish a message to the document channel.
   */
  publish(documentId: string, message: Message<any>): Promise<void>;

  /**
   * Async resource cleanup.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

export type ServerOptions<Context extends ServerContext> = {
  logger?: Logger;
  /**
   * Retrieve per-document storage.
   */
  getStorage: (ctx: {
    documentId: string;
    document: string;
    context: Context;
    encrypted: boolean;
  }) => Promise<DocumentStorage>;

  /**
   * Optional permission checker for read/write.
   */
  checkPermission?: (ctx: {
    context: Context;
    documentId: string;
    document: string;
    message: Message<Context>;
    type: "read" | "write";
  }) => Promise<boolean>;

  /**
   * Replicator backend for cross-node fanout. Defaults to in-memory.
   */
  replicator?: Replicator;
};

export interface Client<Context extends ServerContext> {
  id: string;
  send(message: Message<Context>): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface Session<Context extends ServerContext> {
  readonly documentId: string;
  readonly name: string;
  readonly encrypted: boolean;

  /** Ensure storage is loaded (idempotent). */
  load(): Promise<void>;

  /** Apply a message, optionally from a client (for reply/broadcast semantics). */
  apply(message: Message<Context>, client?: Client<Context>): Promise<void>;

  /** Manage local subscribers. */
  addClient(client: Client<Context>): void;
  removeClient(client: Client<Context>): void;

  [Symbol.asyncDispose](): Promise<void>;
}

export interface Server<Context extends ServerContext> {
  createClient(args: {
    transport: import("teleportal").Transport<Context>;
    id?: string;
  }): Promise<Client<Context>>;

  getOrOpenSession(
    documentId: string,
    options: { encrypted: boolean; name?: string },
  ): Promise<Session<Context>>;

  [Symbol.asyncDispose](): Promise<void>;
}
