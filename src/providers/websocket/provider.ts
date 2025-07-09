import { ObservableV2 } from "lib0/observable";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

import {
  DocMessage,
  StateVector,
  toBinaryTransport,
  type ClientContext,
  type YBinaryTransport,
  type YTransport,
} from "teleportal";
import { getYTransportFromYDoc } from "../../transports";
import { WebsocketConnection } from "./connection-manager";
import type { ReaderInstance } from "./utils";

export type ProviderOptions = {
  client: WebsocketConnection;
  document: string;
  ydoc?: Y.Doc;
  awareness?: Awareness;
  /** Enable local persistence using IndexedDB. Defaults to false. */
  enableLocalPersistence?: boolean;
  /** Custom prefix for IndexedDB storage. Defaults to 'teleportal-'. */
  localPersistencePrefix?: string;
  /** Whether to report as synced immediately if document is available locally. Defaults to true. */
  offlineSupport?: boolean;
  getTransport?: (ctx: {
    ydoc: Y.Doc;
    document: string;
    awareness: Awareness;
    getDefaultTransport(): YTransport<
      ClientContext,
      {
        synced: Promise<void>;
      }
    >;
  }) => YTransport<
    ClientContext,
    {
      synced: Promise<void>;
    }
  >;
};

export class Provider extends ObservableV2<{
  "load-subdoc": (subdoc: string) => void;
  "update-subdocs": () => void;
  "local-synced": () => void;
  "local-sync": () => void;
  "background-synced": () => void;
}> {
  public doc: Y.Doc;
  public awareness: Awareness;
  public transport: YBinaryTransport<{
    synced: Promise<void>;
    key?: CryptoKey;
  }>;
  public document: string;
  #websocketConnection: WebsocketConnection;
  #websocketReader: ReaderInstance;
  #getTransport: ProviderOptions["getTransport"];
  public subdocs: Map<string, Provider> = new Map();
  
  // Local persistence properties
  #localPersistence?: IndexeddbPersistence;
  #enableLocalPersistence: boolean;
  #localPersistencePrefix: string;
  #offlineSupport: boolean;
  #localSynced: boolean = false;

  private constructor({
    client,
    document,
    ydoc = new Y.Doc(),
    awareness = new Awareness(ydoc),
    getTransport = ({ getDefaultTransport }) => getDefaultTransport(),
    enableLocalPersistence = false,
    localPersistencePrefix = 'teleportal-',
    offlineSupport = true,
  }: ProviderOptions) {
    super();
    this.doc = ydoc;
    this.awareness = awareness;
    this.document = document;
    this.#getTransport = getTransport;
    this.#enableLocalPersistence = enableLocalPersistence;
    this.#localPersistencePrefix = localPersistencePrefix;
    this.#offlineSupport = offlineSupport;
    this.transport = toBinaryTransport(
      getTransport({
        ydoc,
        document,
        awareness,
        getDefaultTransport() {
          return getYTransportFromYDoc({ ydoc, document, awareness });
        },
      }),
      { clientId: "remote" },
    );
    this.#websocketConnection = client;
    this.#websocketReader = this.#websocketConnection.getReader();

    this.transport.readable.pipeTo(
      new WritableStream({
        write: (message) => {
          this.#websocketConnection.send(message);
        },
      }),
    );
    this.#websocketReader.readable.pipeTo(this.transport.writable);

    // Initialize local persistence if enabled
    if (this.#enableLocalPersistence) {
      this.initLocalPersistence();
    }

    this.listenToSubdocs();

    if (client.state.type === "connected") {
      this.init();
    }
    client.on("open", this.init);
  }

  private initLocalPersistence() {
    if (!this.#enableLocalPersistence || typeof window === 'undefined') {
      return;
    }

    const persistenceKey = `${this.#localPersistencePrefix}${this.document}`;
    
    try {
      this.#localPersistence = new IndexeddbPersistence(persistenceKey, this.doc);
      
      // Set up event listeners for local persistence
      this.#localPersistence.on('synced', () => {
        this.#localSynced = true;
        this.emit('local-synced', []);
      });

      this.#localPersistence.on('sync', () => {
        this.emit('local-sync', []);
      });

    } catch (error) {
      console.warn('Failed to initialize local persistence:', error);
      this.#enableLocalPersistence = false;
    }
  }

  private init = () => {
    this.#websocketConnection.send(
      new DocMessage(
        this.document,
        {
          type: "sync-step-1",
          sv: Y.encodeStateVector(this.doc) as StateVector,
        },
        { clientId: "local" },
        Boolean(this.transport.key),
      ).encoded,
    );
  };

  private listenToSubdocs() {
    // TODO all a hack at the moment
    this.doc.on("subdocs", ({ loaded, added, removed }) => {
      loaded.forEach((doc) => {
        const item = doc._item;
        if (!item) {
          throw new Error("doc._item is undefined");
        }
        const parentSub = item.parentSub;
        if (!parentSub) {
          throw new Error("doc._item.parentSub is undefined");
        }

        if (this.subdocs.has(parentSub)) {
          console.log("subdoc already exists", parentSub);
        }
        const provider = new Provider({
          client: this.#websocketConnection,
          ydoc: doc,
          document: this.document + "/" + parentSub,
          getTransport: this.#getTransport,
          enableLocalPersistence: this.#enableLocalPersistence,
          localPersistencePrefix: this.#localPersistencePrefix,
          offlineSupport: this.#offlineSupport,
        });
        this.subdocs.set(parentSub, provider);
        this.emit("load-subdoc", [parentSub]);
      });
      // added.forEach((doc) => {
      //   console.log("added", doc.collectionid);
      //   console.log("doc", doc);
      // });
      removed.forEach((doc) => {
        console.log("removed", doc.collectionid);
      });
      this.emit("update-subdocs", []);
    });
  }

  /**
   * Switch this provider to a new document, destroying this provider instance.
   */
  public switchDocument(options: Omit<ProviderOptions, "client">): Provider {
    this.destroy({ destroyWebSocket: false });
    return this.openDocument(options);
  }

  /**
   * Create a new provider instance for a new document, without destroying this provider.
   */
  public openDocument(options: Omit<ProviderOptions, "client">): Provider {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    return new Provider({
      client: this.#websocketConnection,
      ydoc: doc,
      awareness,
      getTransport: this.#getTransport,
      enableLocalPersistence: this.#enableLocalPersistence,
      localPersistencePrefix: this.#localPersistencePrefix,
      offlineSupport: this.#offlineSupport,
      ...options,
    });
  }

  #synced: Promise<void> | null = null;
  /**
   * Resolves when both
   *  - the underlying websocket connection is connected
   *  - the transport is ready (i.e. we've synced the ydoc)
   * 
   * If local persistence is enabled and offline support is enabled,
   * this will resolve immediately when the document is available locally,
   * allowing for offline editing while the websocket syncs in the background.
   */
  public get synced(): Promise<void> {
    if (this.#synced) {
      // re-use the promise if the underlying connection is unchanged
      return this.#synced;
    }

    // If local persistence is enabled and offline support is enabled,
    // we can resolve immediately if the document is available locally
    if (this.#enableLocalPersistence && this.#offlineSupport && this.#localSynced) {
      this.#synced = Promise.resolve();
      return this.#synced;
    }

    // If local persistence is enabled but not yet synced, wait for local sync first
    if (this.#enableLocalPersistence && this.#offlineSupport && this.#localPersistence) {
      const localSynced = new Promise<void>((resolve) => {
        if (this.#localSynced) {
          resolve();
        } else {
          this.#localPersistence!.once('synced', () => {
            resolve();
          });
        }
      });

      this.#synced = localSynced;
      
      // Continue websocket sync in the background for real-time updates
      this.startBackgroundSync();
      
      return this.#synced;
    }

    // Default behavior: wait for both websocket connection and transport
    const synced = Promise.all([
      this.#websocketConnection.connected,
      this.transport.synced,
    ]).then(() => {});

    this.#synced = synced;
    // if the underlying connection changes, then clear out the cached promise
    this.#websocketConnection.once("update", () => {
      this.#synced = null;
    });
    return synced;
  }

  private startBackgroundSync() {
    // Start websocket sync in the background for real-time updates
    Promise.all([
      this.#websocketConnection.connected,
      this.transport.synced,
    ]).then(() => {
      // Background sync completed
      this.emit('background-synced', []);
    }).catch((error) => {
      // Background sync failed, but we're still functional with local data
      console.warn('Background sync failed:', error);
    });
  }

  public get state() {
    return this.#websocketConnection.state;
  }

  public destroy({
    destroyWebSocket = true,
    destroyDoc = true,
  }: {
    destroyWebSocket?: boolean;
    destroyDoc?: boolean;
  } = {}) {
    super.destroy();
    
    // Clean up local persistence
    if (this.#localPersistence) {
      this.#localPersistence.destroy();
      this.#localPersistence = undefined;
    }
    
    // TODO how to clean up the transport?
    // this.transport.readable
    this.#websocketReader.unsubscribe();
    if (destroyWebSocket) {
      this.#websocketConnection.destroy();
    }
    if (destroyDoc) {
      this.doc.destroy();
    }
  }

  public [Symbol.dispose]() {
    this.destroy();
  }

  /**
   * Create a new provider instance, this will always attempt a new websocket connection.
   *
   * If you want to reuse an existing websocket connection provide the `client` option.
   */
  static async create({
    url,
    document,
    ydoc,
    awareness,
    getTransport,
    enableLocalPersistence,
    localPersistencePrefix,
    offlineSupport,
    client = new WebsocketConnection({ url: url! }),
  }: (
    | { url: string; client?: undefined }
    | { url?: undefined; client: WebsocketConnection }
  ) &
    Omit<ProviderOptions, "client">) {
    // Wait for the websocket to connect only if local persistence is disabled
    // or offline support is disabled
    if (!enableLocalPersistence || !offlineSupport) {
      await client.connected;
    }

    return new Provider({
      client,
      ydoc,
      document,
      awareness,
      getTransport,
      enableLocalPersistence,
      localPersistencePrefix,
      offlineSupport,
    });
  }
}
