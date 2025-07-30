import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  Message,
  Observable,
  RawReceivedMessage,
  type ClientContext,
  type Transport,
} from "teleportal";
import {
  getYTransportFromYDoc,
  type FanOutReader,
} from "teleportal/transports";
import { Connection } from "./connection";
import { FallbackConnection } from "./fallback-connection";

export type ProviderOptions = {
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
    getDefaultTransport(): Transport<
      ClientContext,
      {
        synced: Promise<void>;
        client: {
          start: () => Promise<Message>;
        };
      }
    >;
  }) => Transport<
    ClientContext,
    {
      synced: Promise<void>;
      client: {
        start: () => Promise<Message>;
      };
    }
  >;
};

export class Provider extends Observable<{
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
  public transport: Transport<
    ClientContext,
    {
      synced: Promise<void>;
      client: {
        start: () => Promise<Message>;
      };
    }
  >;
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
    getTransport = ({ getDefaultTransport }) => getDefaultTransport(),
    enableOfflinePersistence = true,
    indexedDBPrefix = "teleportal-",
  }: ProviderOptions) {
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
      console.warn("Failed to initialize offline persistence:", error);
      this.#enableOfflinePersistence = false;
    }
  }

  private init = async () => {
    try {
      this.#underlyingConnection.send(await this.transport.client.start());
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
        getTransport: this.#getTransport,
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
  public switchDocument(options: Omit<ProviderOptions, "client">): Provider {
    this.destroy({ destroyConnection: false });
    return this.openDocument(options);
  }

  /**
   * Create a new provider instance for a new document, without destroying this provider.
   */
  public openDocument(options: Omit<ProviderOptions, "client">): Provider {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    return new Provider({
      client: this.#underlyingConnection,
      ydoc: doc,
      awareness,
      getTransport: this.#getTransport,
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
   */
  public get synced(): Promise<void> {
    if (this.#synced) {
      // re-use the promise if the underlying connection is unchanged
      return this.#synced;
    }

    const synced = Promise.all([
      this.#underlyingConnection.connected,
      this.transport.synced,
    ]).then(() => {});

    this.#synced = synced;
    // if the underlying connection changes, then clear out the cached promise
    this.#underlyingConnection.once("update", () => {
      this.#synced = null;
    });
    return synced;
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
   * Create a new provider instance. By default, this will use a FallbackConnection
   * that tries WebSocket first and falls back to HTTP if WebSocket fails.
   *
   * If you want to use a specific connection type, provide the `client` option.
   */
  static async create(
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
      Omit<ProviderOptions, "client">,
  ) {
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
