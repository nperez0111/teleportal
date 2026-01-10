import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  DocMessage,
  Message,
  Milestone,
  Observable,
  RawReceivedMessage,
  type ClientContext,
  type DecodedMilestoneAuthMessage,
  type DecodedMilestoneCreateRequest,
  type DecodedMilestoneListRequest,
  type DecodedMilestoneListResponse,
  type DecodedMilestoneResponse,
  type DecodedMilestoneSnapshotRequest,
  type DecodedMilestoneSnapshotResponse,
  type DecodedMilestoneUpdateNameRequest,
  type MilestoneSnapshot,
  type Transport,
} from "teleportal";
import {
  getYTransportFromYDoc,
  type FanOutReader,
} from "teleportal/transports";
import { Connection } from "./connection";
import { FallbackConnection } from "./fallback-connection";

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
  getTransport?: (ctx: {
    ydoc: Y.Doc;
    document: string;
    awareness: Awareness;
    getDefaultTransport(): Transport<ClientContext, DefaultTransportProperties>;
  }) => T;
};

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
}> {
  public doc: Y.Doc;
  public awareness: Awareness;
  public transport: T;
  public document: string;
  #underlyingConnection: Connection<any>;
  #messageReader: FanOutReader<RawReceivedMessage>;
  #getTransport: ProviderOptions["getTransport"];
  public subdocs: Map<string, Provider> = new Map();

  // Local persistence properties
  #localPersistence?: IndexeddbPersistence;
  #enableOfflinePersistence: boolean;
  #indexedDBPrefix: string;
  #localLoaded: boolean = false;

  private constructor({
    client,
    document,
    ydoc = new Y.Doc(),
    awareness = new Awareness(ydoc),
    getTransport = ({ getDefaultTransport }) => getDefaultTransport() as T,
    enableOfflinePersistence = true,
    indexedDBPrefix = "teleportal-",
  }: ProviderOptions<T>) {
    super();
    this.doc = ydoc;
    this.awareness = awareness;
    this.document = document;
    this.#getTransport = getTransport;
    this.#enableOfflinePersistence = enableOfflinePersistence;
    this.#indexedDBPrefix = indexedDBPrefix;
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
    client.on("connected", this.init);
  }

  private initOfflinePersistence() {
    if (!this.#enableOfflinePersistence || typeof window === "undefined") {
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
    } catch (error) {
      this.#enableOfflinePersistence = false;
    }
  }

  private init = async () => {
    try {
      this.#underlyingConnection.send(await this.transport.handler.start());
      this.#underlyingConnection.on("disconnected", () => {
        this.doc.emit("sync", [false, this.doc]);
      });
      this.#underlyingConnection.on("connected", () => {
        this.doc.emit("sync", [true, this.doc]);
      });
      this.transport.synced
        .then(() => {
          this.doc.emit("sync", [true, this.doc]);
        })
        .catch(() => {
          this.doc.emit("sync", [false, this.doc]);
        });
    } catch (error) {
      console.error("Failed to send sync-step-1", error);
    }
  };

  private subdocListener({
    loaded,
    removed,
  }: {
    loaded: Set<Y.Doc>;
    removed: Set<Y.Doc>;
  }) {
    loaded.forEach((doc) => {
      if (this.subdocs.has(doc.guid)) {
        return;
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
    });

    removed.forEach((doc) => {
      const provider = this.subdocs.get(doc.guid);
      if (!provider) {
        return;
      }
      provider.destroy({ destroyConnection: false });
      this.subdocs.delete(doc.guid);
      this.call("unload-subdoc", {
        subdoc: doc,
        provider,
        document: this.document,
        parentDoc: this.doc,
      });
    });
  }

  /**
   * Switch this provider to a new document, destroying this provider instance.
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
      getTransport: this.#getTransport as any,
      enableOfflinePersistence: this.#enableOfflinePersistence,
      indexedDBPrefix: this.#indexedDBPrefix,
      ...options,
    });
  }

  #synced: Promise<void> | null = null;
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
    // if the underlying connection changes, then clear out the cached promise
    this.#underlyingConnection.once("update", () => {
      this.#synced = null;
    });
    return synced;
  }

  /**
   * Wait for all in-flight messages (excluding awareness) to be acked
   */
  #waitForInFlightMessages(): Promise<void> {
    return new Promise((resolve) => {
      // If there are no in-flight messages, resolve immediately
      if (!this.#underlyingConnection.hasInFlightMessages) {
        resolve();
        return;
      }

      let checkInterval: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      let resolved = false;

      const cleanup = () => {
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };

      const checkAndResolve = () => {
        if (!resolved && !this.#underlyingConnection.hasInFlightMessages) {
          resolved = true;
          cleanup();
          resolve();
        }
      };

      // Poll periodically to check for in-flight messages
      checkInterval = setInterval(checkAndResolve, 10); // Check every 10ms

      // Also listen for message events to catch acks faster
      unsubscribe = this.#underlyingConnection.on("message", checkAndResolve);
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

    // TODO how to clean up the transport?
    // this.transport.readable
    this.#messageReader.unsubscribe();
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
   * Wait for a specific response message matching the predicate.
   * @param predicate - Function that returns true if the message matches, or throws if it's an error response
   * @param timeout - Timeout in milliseconds (default: 30000)
   * @returns Promise that resolves with the matched message
   */
  #waitForResponse<T extends Message>(
    predicate: (message: RawReceivedMessage) => message is T,
    timeout: number = 30000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let resolved = false;
      let unsubscribe: (() => void) | undefined;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = undefined;
        }
      };

      const handleMessage = (message: RawReceivedMessage) => {
        if (resolved) return;

        try {
          if (predicate(message)) {
            resolved = true;
            cleanup();
            resolve(message);
          }
        } catch (error) {
          // Predicate threw an error (e.g., auth denied)
          resolved = true;
          cleanup();
          reject(error);
        }
      };

      // Set up timeout
      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error("Timeout waiting for response message"));
        }
      }, timeout);

      // Listen for messages from the connection
      unsubscribe = this.#underlyingConnection.on("message", handleMessage);
    });
  }

  /**
   * Request a list of all milestones for the current document.
   * @param snapshotIds - Optional array of snapshot IDs to exclude from the response (for incremental updates)
   * @returns Promise that resolves with an array of Milestone instances
   * @throws Error if the operation is denied or if the connection fails
   */
  async listMilestones(snapshotIds?: string[]): Promise<Milestone[]> {
    // Ensure we're connected
    await this.synced;

    // Send the request
    const request = new DocMessage(
      this.document,
      {
        type: "milestone-list-request",
        snapshotIds: snapshotIds ?? [],
      } as DecodedMilestoneListRequest,
      undefined,
      false, // TODO: Determine encryption from document/transport
    );

    await this.#underlyingConnection.send(request);

    // Wait for response and handle errors
    try {
      const response = await this.#waitForResponse<DocMessage<ClientContext>>(
        (msg): msg is DocMessage<ClientContext> => {
          if (msg.type !== "doc" || msg.document !== this.document)
            return false;
          const payload = msg.payload as any;
          // Check for auth errors first
          if (payload.type === "milestone-auth-message") {
            const authMsg = payload as DecodedMilestoneAuthMessage;
            throw new Error(`Milestone operation denied: ${authMsg.reason}`);
          }
          return payload.type === "milestone-list-response";
        },
      );

      const payload = response.payload as DecodedMilestoneListResponse;

      // Convert metadata to Milestone instances with lazy snapshot loading
      return payload.milestones.map(
        (meta) =>
          new Milestone({
            id: meta.id,
            name: meta.name,
            documentId: meta.documentId,
            createdAt: meta.createdAt,
            getSnapshot: (documentId: string, id: string) =>
              this.getMilestoneSnapshot(id),
          }),
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("denied")) {
        throw error;
      }
      throw new Error(
        `Failed to list milestones: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Request the snapshot content for a specific milestone.
   * @param milestoneId - The ID of the milestone to fetch
   * @returns Promise that resolves with the MilestoneSnapshot (Uint8Array)
   * @throws Error if the operation is denied or if the connection fails
   */
  async getMilestoneSnapshot(milestoneId: string): Promise<MilestoneSnapshot> {
    // Ensure we're connected
    await this.synced;

    // Send the request
    const request = new DocMessage(
      this.document,
      {
        type: "milestone-snapshot-request",
        milestoneId,
      } as DecodedMilestoneSnapshotRequest,
      undefined,
      false, // TODO: Determine encryption from document/transport
    );

    await this.#underlyingConnection.send(request);

    // Wait for response and handle errors
    try {
      const response = await this.#waitForResponse<DocMessage<ClientContext>>(
        (msg): msg is DocMessage<ClientContext> => {
          if (msg.type !== "doc" || msg.document !== this.document)
            return false;
          const payload = msg.payload as any;
          // Check for auth errors first
          if (payload.type === "milestone-auth-message") {
            const authMsg = payload as DecodedMilestoneAuthMessage;
            throw new Error(`Milestone operation denied: ${authMsg.reason}`);
          }
          // Verify this is the response for the requested milestone
          if (payload.type === "milestone-snapshot-response") {
            return (
              (payload as DecodedMilestoneSnapshotResponse).milestoneId ===
              milestoneId
            );
          }
          return false;
        },
      );

      const payload = response.payload as DecodedMilestoneSnapshotResponse;
      return payload.snapshot;
    } catch (error) {
      if (error instanceof Error && error.message.includes("denied")) {
        throw error;
      }
      throw new Error(
        `Failed to get milestone snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Create a new milestone from the current document state.
   * @param name - Optional name for the milestone. If not provided, the server will auto-generate one.
   * @returns Promise that resolves with the created Milestone instance
   * @throws Error if the operation is denied or if the connection fails
   */
  async createMilestone(name?: string): Promise<Milestone> {
    // Ensure we're connected
    await this.synced;
    // TODO encrypted milestones?
    const snapshot = Y.encodeStateAsUpdateV2(this.doc) as MilestoneSnapshot;

    // Send the request
    const request = new DocMessage(
      this.document,
      {
        type: "milestone-create-request",
        name,
        snapshot,
      } as DecodedMilestoneCreateRequest,
      undefined,
      false, // TODO: Determine encryption from document/transport
    );

    await this.#underlyingConnection.send(request);

    // Wait for response and handle errors
    try {
      const response = await this.#waitForResponse<DocMessage<ClientContext>>(
        (msg): msg is DocMessage<ClientContext> => {
          if (msg.type !== "doc" || msg.document !== this.document)
            return false;
          const payload = msg.payload as any;
          // Check for auth errors first
          if (payload.type === "milestone-auth-message") {
            const authMsg = payload as DecodedMilestoneAuthMessage;
            throw new Error(`Milestone operation denied: ${authMsg.reason}`);
          }
          return payload.type === "milestone-create-response";
        },
      );

      const payload = response.payload as DecodedMilestoneResponse;
      const meta = payload.milestone;

      // Convert to Milestone instance with lazy snapshot loading
      return new Milestone({
        id: meta.id,
        name: meta.name,
        documentId: meta.documentId,
        createdAt: meta.createdAt,
        getSnapshot: (documentId: string, id: string) =>
          this.getMilestoneSnapshot(id),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("denied")) {
        throw error;
      }
      throw new Error(
        `Failed to create milestone: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    // Ensure we're connected
    await this.synced;

    // Send the request
    const request = new DocMessage(
      this.document,
      {
        type: "milestone-update-name-request",
        milestoneId,
        name,
      } as DecodedMilestoneUpdateNameRequest,
      undefined,
      false, // TODO: Determine encryption from document/transport
    );

    await this.#underlyingConnection.send(request);

    // Wait for response and handle errors
    try {
      const response = await this.#waitForResponse<DocMessage<ClientContext>>(
        (msg): msg is DocMessage<ClientContext> => {
          if (msg.type !== "doc" || msg.document !== this.document)
            return false;
          const payload = msg.payload as any;
          // Check for auth errors first
          if (payload.type === "milestone-auth-message") {
            const authMsg = payload as DecodedMilestoneAuthMessage;
            throw new Error(`Milestone operation denied: ${authMsg.reason}`);
          }
          // Verify this is the response for the requested milestone
          if (payload.type === "milestone-update-name-response") {
            return (
              (payload as DecodedMilestoneResponse).milestone.id === milestoneId
            );
          }
          return false;
        },
      );

      const payload = response.payload as DecodedMilestoneResponse;
      const meta = payload.milestone;

      // Convert to Milestone instance with lazy snapshot loading
      return new Milestone({
        id: meta.id,
        name: meta.name,
        documentId: meta.documentId,
        createdAt: meta.createdAt,
        getSnapshot: (documentId: string, id: string) =>
          this.getMilestoneSnapshot(id),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("denied")) {
        throw error;
      }
      throw new Error(
        `Failed to update milestone name: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    });
  }
}
