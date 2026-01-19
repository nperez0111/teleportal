import { EventClient } from "@tanstack/devtools-event-client";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  Message,
  Milestone,
  Observable,
  RawReceivedMessage,
  RpcMessage,
  type ClientContext,
  type MilestoneSnapshot,
  type Transport,
} from "teleportal";
import {
  getYTransportFromYDoc,
  type FanOutReader,
} from "teleportal/transports";
import {
  type MilestoneCreateResponse,
  type MilestoneDeleteResponse,
  type MilestoneGetResponse,
  type MilestoneListResponse,
  type MilestoneRestoreResponse,
  type MilestoneUpdateNameResponse,
} from "../protocols/milestone";
import { Connection, ConnectionContext, ConnectionState } from "./connection";
import { FallbackConnection } from "./fallback-connection";
import { RpcClient, RpcOperationError } from "./rpc-client";
import type {
  ClientRpcHandlerRegistry,
  ClientRpcContext,
} from "./rpc-handlers";

/**
 * Error thrown when a milestone operation is denied
 */
export class MilestoneOperationDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(`Milestone operation denied: ${reason}`);
    this.name = "MilestoneOperationDeniedError";
  }
}

/**
 * Error thrown when a milestone operation fails
 */
export class MilestoneOperationError extends Error {
  constructor(
    public readonly operation: string,
    cause?: unknown,
  ) {
    const message =
      cause instanceof Error
        ? `Failed to ${operation}: ${cause.message}`
        : `Failed to ${operation}: ${String(cause)}`;
    super(message, { cause });
    this.name = "MilestoneOperationError";
  }
}

/**
 * Error thrown when a file operation is denied
 */
export class FileOperationDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(`File operation denied: ${reason}`);
    this.name = "FileOperationDeniedError";
  }
}

/**
 * Error thrown when a file operation fails
 */
export class FileOperationError extends Error {
  constructor(
    public readonly operation: string,
    cause?: unknown,
  ) {
    const message =
      cause instanceof Error
        ? `Failed to ${operation}: ${cause.message}`
        : `Failed to ${operation}: ${String(cause)}`;
    super(message, { cause });
    this.name = "FileOperationError";
  }
}

export type DefaultTransportProperties = {
  synced: Promise<void>;
  handler: {
    start: () => Promise<Message>;
  };
};

export type ProviderOptions<
  T extends Transport<ClientContext, DefaultTransportProperties> = Transport<
    ClientContext,
    DefaultTransportProperties
  >,
> = {
  client: Connection<any>;
  document: string;
  ydoc?: Y.Doc;
  awareness?: Awareness;
  /** Enable offline persistence using IndexedDB. Defaults to true. */
  enableOfflinePersistence?: boolean;
  /** Custom prefix for IndexedDB storage. Defaults to 'teleportal-'. */
  indexedDBPrefix?: string;
  /** Optional encryption key for file operations */
  encryptionKey?: CryptoKey;
  /** RPC handlers for client-side RPC operations (e.g., file upload/download) */
  rpcHandlers?: ClientRpcHandlerRegistry;
  getTransport?: (ctx: {
    ydoc: Y.Doc;
    document: string;
    awareness: Awareness;
    getDefaultTransport(): Transport<ClientContext, DefaultTransportProperties>;
  }) => T;
};

export const teleportalEventClient = new EventClient<
  {
    "teleportal-provider:load-subdoc": {
      subdoc: Y.Doc;
      provider: Provider;
      document: string;
      parentDoc: Y.Doc;
    };
    "teleportal-provider:unload-subdoc": {
      subdoc: Y.Doc;
      provider: Provider;
      document: string;
      parentDoc: Y.Doc;
    };
    "teleportal-provider:received-message": {
      message: RawReceivedMessage;
      provider: Provider;
      connection: Connection<any>;
    };
    "teleportal-provider:sent-message": {
      message: Message;
      provider: Provider;
      connection: Connection<any>;
    };
    "teleportal-provider:connected": {
      provider: Provider;
      connection: Connection<any>;
    };
    "teleportal-provider:disconnected": {
      provider: Provider;
      connection: Connection<any>;
    };
    "teleportal-provider:update": {
      state: ConnectionState<ConnectionContext>;
      provider: Provider;
      connection: Connection<any>;
    };
  },
  "teleportal-provider"
>({
  pluginId: "teleportal-provider",
});

export class Provider<
  T extends Transport<ClientContext, DefaultTransportProperties> = Transport<
    ClientContext,
    DefaultTransportProperties
  >,
> extends Observable<{
  "load-subdoc": (ctx: {
    subdoc: Y.Doc;
    provider: Provider;
    document: string;
    parentDoc: Y.Doc;
  }) => void;
  "unload-subdoc": (ctx: {
    subdoc: Y.Doc;
    provider: Provider;
    document: string;
    parentDoc: Y.Doc;
  }) => void;
  "received-message": (message: RawReceivedMessage) => void;
  "sent-message": (message: Message) => void;
  connected: () => void;
  disconnected: () => void;
  update: (state: ConnectionState<ConnectionContext>) => void;
}> {
  public doc: Y.Doc;
  public awareness: Awareness;
  public transport: T;
  public document: string;
  #underlyingConnection: Connection<any>;
  #messageReader: FanOutReader<RawReceivedMessage>;
  #getTransport: ProviderOptions["getTransport"];
  public subdocs: Map<string, Provider> = new Map();
  #rpcClient: RpcClient;
  #rpcHandlers: ClientRpcHandlerRegistry;
  #handlerCleanups: Array<() => void> = [];
  public encryptionKey?: CryptoKey;

  // Local persistence properties
  #localPersistence?: IndexeddbPersistence;
  #enableOfflinePersistence: boolean;
  #indexedDBPrefix: string;
  #localLoaded: boolean = false;

  abortController = new AbortController();
  #initInProgress = false;

  private constructor({
    client,
    document,
    ydoc = new Y.Doc(),
    awareness = new Awareness(ydoc),
    getTransport = ({ getDefaultTransport }) => getDefaultTransport() as T,
    enableOfflinePersistence = true,
    indexedDBPrefix = "teleportal-",
    encryptionKey,
    rpcHandlers = {},
  }: ProviderOptions<T>) {
    super();
    this.doc = ydoc;
    this.awareness = awareness;
    this.document = document;
    this.#getTransport = getTransport;
    this.#enableOfflinePersistence = enableOfflinePersistence;
    this.#indexedDBPrefix = indexedDBPrefix;
    this.encryptionKey = encryptionKey;
    this.#rpcHandlers = rpcHandlers;
    this.transport = getTransport({
      ydoc,
      document,
      awareness,
      getDefaultTransport() {
        return getYTransportFromYDoc({ ydoc, document, awareness });
      },
    });
    this.#underlyingConnection = client;
    this.#messageReader = this.#underlyingConnection.getReader();
    this.#rpcClient = new RpcClient(client);

    // Initialize RPC handlers
    this.#initRpcHandlers();

    this.transport.readable.pipeTo(
      new WritableStream({
        write: (message) => {
          this.#underlyingConnection.send(message);
        },
      }),
    );
    this.#messageReader.readable.pipeTo(this.transport.writable);

    this.doc.on("subdocs", this.subdocListener);

    // Initialize offline persistence if enabled
    if (this.#enableOfflinePersistence) {
      this.initOfflinePersistence();
    }

    if (client.state.type === "connected") {
      this.init();
    }

    this.abortController.signal.addEventListener(
      "abort",
      client.on("connected", this.init),
    );
    this.abortController.signal.addEventListener(
      "abort",
      client.on("connected", () => {
        this.call("connected");
        teleportalEventClient.emit("connected", {
          provider: this,
          connection: client,
        });
      }),
    );
    this.abortController.signal.addEventListener(
      "abort",
      client.on("disconnected", () => {
        this.call("disconnected");
        teleportalEventClient.emit("disconnected", {
          provider: this,
          connection: client,
        });
      }),
    );
    this.abortController.signal.addEventListener(
      "abort",
      client.on("received-message", (message) => {
        this.call("received-message", message);
        teleportalEventClient.emit("received-message", {
          message,
          provider: this,
          connection: client,
        });
        // RPC messages and ACKs are routed in #initRpcHandlers()
      }),
    );
    this.abortController.signal.addEventListener(
      "abort",
      client.on("sent-message", (message) => {
        this.call("sent-message", message);
        teleportalEventClient.emit("sent-message", {
          message,
          provider: this,
          connection: client,
        });
      }),
    );
    this.abortController.signal.addEventListener(
      "abort",
      client.on("update", (state) => {
        this.call("update", state);
        teleportalEventClient.emit("update", {
          state,
          provider: this,
          connection: client,
        });
      }),
    );
  }

  private initOfflinePersistence() {
    if (!this.#enableOfflinePersistence || globalThis.window === undefined) {
      return;
    }

    const persistenceKey = `${this.#indexedDBPrefix}${this.document}`;

    try {
      this.#localPersistence = new IndexeddbPersistence(
        persistenceKey,
        this.doc,
      );

      // Set up event listener for local persistence
      this.#localPersistence.on("synced", () => {
        this.#localLoaded = true;
      });
    } catch {
      this.#enableOfflinePersistence = false;
    }
  }

  private init = async () => {
    // Make init idempotent - if already in progress, wait for it
    if (this.#initInProgress) {
      return;
    }

    this.#initInProgress = true;
    try {
      this.#underlyingConnection.send(await this.transport.handler.start());

      this.abortController.signal.addEventListener(
        "abort",
        this.#underlyingConnection.on("disconnected", () => {
          this.doc.emit("sync", [false, this.doc]);
        }),
      );
      this.abortController.signal.addEventListener(
        "abort",
        this.#underlyingConnection.on("connected", () => {
          this.doc.emit("sync", [true, this.doc]);
        }),
      );
      this.transport.synced
        .then(() => {
          this.doc.emit("sync", [true, this.doc]);
        })
        .catch(() => {
          this.doc.emit("sync", [false, this.doc]);
        });
    } catch (error) {
      console.error("Failed to send sync-step-1", error);
    } finally {
      this.#initInProgress = false;
    }
  };

  private subdocListener({
    loaded,
    removed,
  }: {
    loaded: Set<Y.Doc>;
    removed: Set<Y.Doc>;
  }) {
    for (const doc of loaded) {
      if (this.subdocs.has(doc.guid)) {
        continue;
      }
      const provider = this.openDocument({
        document: this.document + "/" + doc.guid,
        ydoc: doc,
        awareness: this.awareness,
        getTransport: this.#getTransport as any,
      });

      this.subdocs.set(doc.guid, provider);

      this.call("load-subdoc", {
        subdoc: doc,
        provider,
        document: this.document,
        parentDoc: this.doc,
      });
    }

    for (const doc of removed) {
      const provider = this.subdocs.get(doc.guid);
      if (!provider) {
        continue;
      }
      provider.destroy({ destroyConnection: false });
      this.subdocs.delete(doc.guid);
      this.call("unload-subdoc", {
        subdoc: doc,
        provider,
        document: this.document,
        parentDoc: this.doc,
      });
    }
  }

  /**
   * Switch this provider to a new document, destroying this provider instance.
   *
   * **Lifecycle:**
   * - The current provider instance is destroyed (this instance becomes unusable)
   * - The current Y.Doc is destroyed (all local data is lost)
   * - All event listeners, offline persistence, and cached promises are cleaned up
   * - The underlying connection is preserved and reused for the new document
   * - Pending in-flight messages for the old document are abandoned
   * - A new provider instance is created and returned for the new document
   *
   * **Use case:** Efficiently switch between documents while maintaining the same
   * connection, avoiding the overhead of establishing a new connection.
   *
   * @param options - Provider options for the new document (excluding `client`, which is reused)
   * @returns A new Provider instance for the new document
   */
  public switchDocument(
    options: Omit<ProviderOptions<T>, "client">,
  ): Provider<T> {
    this.destroy({ destroyConnection: false });
    return this.openDocument(options);
  }

  /**
   * Create a new provider instance for a new document, without destroying this provider.
   */
  public openDocument(
    options: Omit<ProviderOptions<T>, "client">,
  ): Provider<T> {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    return new Provider<T>({
      client: this.#underlyingConnection,
      ydoc: doc,
      awareness,
      getTransport: options.getTransport ?? (this.#getTransport as any),
      enableOfflinePersistence:
        options.enableOfflinePersistence ?? this.#enableOfflinePersistence,
      indexedDBPrefix: options.indexedDBPrefix ?? this.#indexedDBPrefix,
      encryptionKey: options.encryptionKey ?? this.encryptionKey,
      rpcHandlers: options.rpcHandlers ?? this.#rpcHandlers,
      document: options.document,
    });
  }

  #synced: Promise<void> | null = null;
  #syncedUnsubscribe: (() => void) | null = null;
  #loaded: Promise<void> | null = null;

  /**
   * Resolves when the document is loaded (from local storage if available, or from network)
   */
  public get loaded(): Promise<void> {
    if (this.#loaded) {
      return this.#loaded;
    }

    if (this.#enableOfflinePersistence && this.#localPersistence) {
      // Wait for local persistence to load
      const localLoaded = new Promise<void>((resolve) => {
        if (this.#localLoaded) {
          resolve();
        } else {
          this.#localPersistence!.once("synced", () => {
            resolve();
          });
        }
      });
      this.#loaded = localLoaded;
      return this.#loaded;
    }

    // If no offline persistence, loaded is same as synced
    this.#loaded = this.synced;
    return this.#loaded;
  }

  /**
   * Resolves when both
   *  - the underlying connection is connected
   *  - the transport is ready (i.e. we've synced the ydoc)
   *  - there are no in-flight messages (excluding awareness messages)
   */
  public get synced(): Promise<void> {
    if (this.#synced) {
      // re-use the promise if the underlying connection is unchanged
      return this.#synced;
    }

    const synced = Promise.all([
      this.#underlyingConnection.connected,
      this.transport.synced,
      this.#waitForInFlightMessages(),
    ]).then(() => {});

    this.#synced = synced;
    // Invalidate cached promise when connection state changes to disconnected or errored
    // (but not on every update, only when it matters)
    this.#syncedUnsubscribe = this.#underlyingConnection.on(
      "update",
      (state) => {
        if (state.type === "disconnected" || state.type === "errored") {
          this.#clearSyncedPromise();
        }
      },
    );
    return synced;
  }

  /**
   * Clear the cached synced promise and unsubscribe
   */
  #clearSyncedPromise() {
    if (this.#syncedUnsubscribe) {
      this.#syncedUnsubscribe();
      this.#syncedUnsubscribe = null;
    }
    this.#synced = null;
  }

  /**
   * Wait for all in-flight messages (excluding awareness) to be acked
   */
  #waitForInFlightMessages(): Promise<void> {
    return new Promise((resolve) => {
      // If there are no in-flight messages, resolve immediately
      if (this.#underlyingConnection.inFlightMessageCount === 0) {
        resolve();
        return;
      }

      let unsubscribe: (() => void) | null = null;
      let resolved = false;

      const cleanup = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };

      // Listen for the messages-in-flight event
      unsubscribe = this.#underlyingConnection.on(
        "messages-in-flight",
        (hasInFlight) => {
          if (!resolved && !hasInFlight) {
            resolved = true;
            cleanup();
            resolve();
          }
        },
      );
    });
  }

  public get state() {
    return this.#underlyingConnection.state;
  }

  /**
   * Get the active connection type if using FallbackConnection
   */
  public get connectionType(): "websocket" | "http" | null {
    if (this.#underlyingConnection instanceof FallbackConnection) {
      return this.#underlyingConnection.connectionType;
    }
    return null;
  }

  public destroy({
    destroyConnection = true,
    destroyDoc = true,
  }: {
    destroyConnection?: boolean;
    destroyDoc?: boolean;
  } = {}) {
    this.doc.off("subdocs", this.subdocListener);
    super.destroy();

    // Clean up offline persistence
    if (this.#localPersistence) {
      this.#localPersistence.destroy();
      this.#localPersistence = undefined;
    }

    // Clean up previous listeners if they exist
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }

    // Clean up synced promise
    this.#clearSyncedPromise();

    // Clean up transport streams properly
    try {
      // Cancel the transport readable stream to stop piping
      this.transport.readable.cancel().catch(() => {});
      // Close the transport writable stream
      this.transport.writable.close().catch(() => {});
    } catch {
      // Ignore stream cleanup errors
    }

    this.#messageReader.unsubscribe();
    this.#rpcClient.destroy();

    // Clean up RPC handlers
    for (const cleanup of this.#handlerCleanups) {
      cleanup();
    }
    this.#handlerCleanups = [];

    if (destroyConnection) {
      this.#underlyingConnection.destroy();
    }
    if (destroyDoc) {
      this.doc.destroy();
    }
  }

  public [Symbol.dispose]() {
    this.destroy();
  }

  /**
   * Helper to create a Milestone instance from metadata
   */
  #createMilestoneFromMeta(meta: {
    id: string;
    name: string;
    documentId: string;
    createdAt: number;
    deletedAt?: number;
    createdBy: { type: "user" | "system"; id: string };
  }): Milestone {
    return new Milestone({
      id: meta.id,
      name: meta.name,
      documentId: meta.documentId,
      createdAt: meta.createdAt,
      createdBy: meta.createdBy,
      getSnapshot: (documentId: string, id: string) =>
        this.getMilestoneSnapshot(id),
    });
  }

  /**
   * Request a list of all milestones for the current document.
   * @param optionsOrSnapshotIds - Optional options object or array of snapshot IDs to exclude from the response
   * @returns Promise that resolves with an array of Milestone instances
   * @throws Error if the operation is denied or if the connection fails
   */
  async listMilestones(
    optionsOrSnapshotIds?:
      | string[]
      | { includeDeleted?: boolean; snapshotIds?: string[] },
  ): Promise<Milestone[]> {
    const snapshotIds = Array.isArray(optionsOrSnapshotIds)
      ? optionsOrSnapshotIds
      : (optionsOrSnapshotIds?.snapshotIds ?? []);
    const includeDeleted = !Array.isArray(optionsOrSnapshotIds)
      ? optionsOrSnapshotIds?.includeDeleted
      : false;

    try {
      const response = await this.#rpcClient.sendRequest<MilestoneListResponse>(
        this.document,
        "milestoneList",
        { snapshotIds, includeDeleted },
      );

      return response.milestones.map((meta) =>
        this.#createMilestoneFromMeta(meta),
      );
    } catch (error) {
      if (error instanceof RpcOperationError) {
        throw new MilestoneOperationError("list milestones", error);
      }
      throw error;
    }
  }

  /**
   * Request the snapshot content for a specific milestone.
   * @param milestoneId - The ID of the milestone to fetch
   * @returns Promise that resolves with the MilestoneSnapshot (Uint8Array)
   * @throws Error if the operation is denied or if the connection fails
   */
  async getMilestoneSnapshot(milestoneId: string): Promise<MilestoneSnapshot> {
    try {
      const response = await this.#rpcClient.sendRequest<MilestoneGetResponse>(
        this.document,
        "milestoneGet",
        { milestoneId },
      );

      return response.snapshot as unknown as MilestoneSnapshot;
    } catch (error) {
      if (error instanceof RpcOperationError) {
        throw new MilestoneOperationError("get milestone snapshot", error);
      }
      throw error;
    }
  }

  /**
   * Create a new milestone from the current document state.
   * @param name - Optional name for the milestone. If not provided, the server will auto-generate one.
   * @returns Promise that resolves with the created Milestone instance
   * @throws Error if the operation is denied or if the connection fails
   */
  async createMilestone(name?: string): Promise<Milestone> {
    const snapshot = Y.encodeStateAsUpdateV2(
      this.doc,
    ) as unknown as MilestoneSnapshot;

    try {
      const response =
        await this.#rpcClient.sendRequest<MilestoneCreateResponse>(
          this.document,
          "milestoneCreate",
          { name, snapshot },
        );

      return this.#createMilestoneFromMeta(response.milestone);
    } catch (error) {
      if (error instanceof RpcOperationError) {
        throw new MilestoneOperationError("create milestone", error);
      }
      throw error;
    }
  }

  /**
   * Update the name of an existing milestone.
   * @param milestoneId - The ID of the milestone to update
   * @param name - The new name for the milestone
   * @returns Promise that resolves with the updated Milestone instance
   * @throws Error if the operation is denied or if the connection fails
   */
  async updateMilestoneName(
    milestoneId: string,
    name: string,
  ): Promise<Milestone> {
    try {
      const response =
        await this.#rpcClient.sendRequest<MilestoneUpdateNameResponse>(
          this.document,
          "milestoneUpdateName",
          { milestoneId, name },
        );

      return this.#createMilestoneFromMeta(response.milestone);
    } catch (error) {
      if (error instanceof RpcOperationError) {
        throw new MilestoneOperationError("update milestone name", error);
      }
      throw error;
    }
  }

  /**
   * Soft delete a milestone.
   * @param milestoneId - The ID of the milestone to soft delete
   * @returns Promise that resolves when the milestone is deleted
   * @throws Error if the operation is denied or if the connection fails
   */
  async deleteMilestone(milestoneId: string): Promise<void> {
    try {
      await this.#rpcClient.sendRequest<MilestoneDeleteResponse>(
        this.document,
        "milestoneDelete",
        { milestoneId },
      );
    } catch (error) {
      if (error instanceof RpcOperationError) {
        throw new MilestoneOperationError("delete milestone", error);
      }
      throw error;
    }
  }

  /**
   * Restore a soft deleted milestone.
   * @param milestoneId - The ID of the milestone to restore
   * @returns Promise that resolves with the restored Milestone instance
   * @throws Error if the operation is denied or if the connection fails
   */
  async restoreMilestone(milestoneId: string): Promise<Milestone> {
    try {
      const response =
        await this.#rpcClient.sendRequest<MilestoneRestoreResponse>(
          this.document,
          "milestoneRestore",
          { milestoneId },
        );

      return this.#createMilestoneFromMeta(response.milestone);
    } catch (error) {
      if (error instanceof RpcOperationError) {
        throw new MilestoneOperationError("restore milestone", error);
      }
      throw error;
    }
  }

  /**
   * Initialize RPC handlers.
   */
  #initRpcHandlers() {
    // Set up message routing for RPC handlers
    // We route messages from the connection directly, not through RpcClient,
    // so handlers can process responses even if RpcClient has already handled them
    const unregister = this.#underlyingConnection.on(
      "received-message",
      async (message) => {
        if (message.type === "rpc") {
          await this.#routeRpcMessage(message);
        } else if (message.type === "ack") {
          await this.#routeAckMessage(message);
        }
      },
    );
    this.#handlerCleanups.push(unregister);

    // Track which handler instances we've already set up (since fileUpload and fileDownload share the same instance)
    const setupHandlers = new Set<object>();

    // Initialize each handler
    for (const [method, handler] of Object.entries(this.#rpcHandlers)) {
      if (handler.init) {
        const cleanup = handler.init(this);
        if (cleanup) {
          this.#handlerCleanups.push(cleanup);
        }
      }

      // Set up RPC client for file handlers (they need it to send messages)
      // Both fileUpload and fileDownload use the same handler instance
      if (
        (method === "fileUpload" || method === "fileDownload") &&
        "setRpcClient" in handler &&
        typeof (handler as any).setRpcClient === "function" &&
        !setupHandlers.has(handler)
      ) {
        setupHandlers.add(handler);
        (handler as any).setRpcClient(
          this.#rpcClient,
          async (msg: Message<any>) => {
            await this.#rpcClient.sendStream(msg as RpcMessage<any>);
          },
        );
      }
    }
  }

  /**
   * Route an incoming RPC message to the appropriate handler.
   */
  async #routeRpcMessage(message: RawReceivedMessage): Promise<void> {
    if (message.type !== "rpc") {
      return;
    }

    const rpcMessage = message as RpcMessage<any>;
    const method = rpcMessage.rpcMethod;
    const handler = this.#rpcHandlers[method];

    if (!handler) {
      return;
    }

    // Route based on message type
    if (rpcMessage.requestType === "response" && handler.handleResponse) {
      const handled = await handler.handleResponse(rpcMessage);
      if (handled) {
        return;
      }
    }

    if (rpcMessage.requestType === "stream" && handler.handleStream) {
      const handled = await handler.handleStream(rpcMessage);
      if (handled) {
        return;
      }
    }
  }

  /**
   * Route an incoming ACK message to handlers.
   */
  async #routeAckMessage(message: RawReceivedMessage): Promise<void> {
    if (message.type !== "ack") {
      return;
    }

    // Try all handlers - ACKs don't have a method name
    for (const handler of Object.values(this.#rpcHandlers)) {
      if (handler.handleAck) {
        const handled = await handler.handleAck(message as Message<any>);
        if (handled) {
          return;
        }
      }
    }
  }

  /**
   * Upload a file to the server.
   * @param file - The file to upload
   * @param fileId - Optional client-generated identifier for the file (defaults to a random UUID)
   * @param encryptionKey - Optional encryption key for encrypting the file
   * @returns Promise that resolves with the fileId of the uploaded file
   * @throws FileOperationError if file handlers are not registered
   * @throws FileOperationDeniedError if the upload is denied by the server
   */
  async uploadFile(
    file: File,
    fileId?: string,
    encryptionKey?: CryptoKey,
  ): Promise<string> {
    // Check both fileUpload and fileDownload since they might be the same handler instance
    const fileHandler = (this.#rpcHandlers.fileUpload ||
      this.#rpcHandlers.fileDownload) as any;
    if (!fileHandler || typeof (fileHandler as any).uploadFile !== "function") {
      throw new FileOperationError(
        "upload file",
        new Error(
          "File upload handler not registered. Add file handlers via rpcHandlers option: rpcHandlers: { ...getFileClientHandlers() }",
        ),
      );
    }

    try {
      return await fileHandler.uploadFile(
        file,
        this.document,
        fileId,
        encryptionKey ?? this.encryptionKey,
      );
    } catch (error) {
      if (error instanceof FileOperationDeniedError) {
        throw error;
      }
      throw new FileOperationError("upload file", error);
    }
  }

  /**
   * Download a file from the server.
   * @param fileId - The fileId (merkle root hash) of the file to download
   * @param encryptionKey - Optional encryption key for decrypting the file
   * @param timeout - Optional timeout in milliseconds (defaults to 60000)
   * @returns Promise that resolves with the downloaded File
   * @throws FileOperationError if file handlers are not registered
   * @throws FileOperationDeniedError if the download is denied by the server
   */
  async downloadFile(
    fileId: string,
    encryptionKey?: CryptoKey,
    timeout?: number,
  ): Promise<File> {
    // Check both fileUpload and fileDownload since they might be the same handler instance
    const fileHandler = (this.#rpcHandlers.fileDownload ||
      this.#rpcHandlers.fileUpload) as any;
    if (
      !fileHandler ||
      typeof (fileHandler as any).downloadFile !== "function"
    ) {
      throw new FileOperationError(
        "download file",
        new Error(
          "File download handler not registered. Add file handlers via rpcHandlers option: rpcHandlers: { ...getFileClientHandlers() }",
        ),
      );
    }

    try {
      return await fileHandler.downloadFile(
        fileId,
        this.document,
        encryptionKey ?? this.encryptionKey,
        timeout,
      );
    } catch (error) {
      if (error instanceof FileOperationDeniedError) {
        throw error;
      }
      throw new FileOperationError("download file", error);
    }
  }

  /**
   * Create a new provider instance. By default, this will use a FallbackConnection
   * that tries WebSocket first and falls back to HTTP if WebSocket fails.
   *
   * If you want to use a specific connection type, provide the `client` option.
   */
  static async create<
    T extends Transport<ClientContext, DefaultTransportProperties> = Transport<
      ClientContext,
      DefaultTransportProperties
    >,
  >(
    options: (
      | {
          url: string;
          client?: undefined;
          /** Timeout for WebSocket connection attempts in milliseconds @default 5000 */
          websocketTimeout?: number;
          /** WebSocket-specific options */
          websocketOptions?: {
            protocols?: string[];
            WebSocket?: typeof WebSocket;
          };
          /** HTTP-specific options */
          httpOptions?: {
            fetch?: typeof fetch;
            EventSource?: typeof EventSource;
          };
        }
      | { url?: undefined; client: Connection<any> }
    ) &
      Omit<ProviderOptions<T>, "client">,
  ): Promise<Provider<T>> {
    const {
      url,
      document,
      ydoc,
      awareness,
      getTransport,
      enableOfflinePersistence,
      indexedDBPrefix,
      encryptionKey,
      rpcHandlers,
      client,
    } = options;

    // Create connection based on options
    const connection =
      client ??
      new FallbackConnection({
        url: url!,
        websocketTimeout:
          "websocketTimeout" in options ? options.websocketTimeout : undefined,
        websocketOptions:
          "websocketOptions" in options ? options.websocketOptions : undefined,
        httpOptions: "httpOptions" in options ? options.httpOptions : undefined,
      });

    // Wait for the connection to connect
    await connection.connected;

    return new Provider({
      client: connection,
      ydoc,
      document,
      awareness,
      getTransport,
      enableOfflinePersistence,
      indexedDBPrefix,
      encryptionKey,
      rpcHandlers,
    });
  }
}
