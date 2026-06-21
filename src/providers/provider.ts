import { EventClient } from "@tanstack/devtools-event-client";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  Message,
  Observable,
  PresenceMessage,
  RawReceivedMessage,
  type ClientContext,
  type Transport,
} from "teleportal";
import {
  getYTransportFromYDoc,
  getEncryptedTransport,
  EncryptionClient,
  type FanOutReader,
} from "teleportal/transports";
import { Connection, type ConnectionState } from "./connection";
import { RpcClient } from "./rpc-client";
import { websocketTransport } from "./transports/websocket";
import { httpTransport } from "./transports/http";
import type { ConnectionTransport, TokenOptions } from "./transports/types";
import type {
  RpcExtension,
  RpcExtensionContext,
  RpcExtensionMap,
  RpcNamespace,
} from "./rpc-extension";

export type PresenceEvent = {
  awarenessId: number;
  clientId: string;
  userId: string;
  data: Record<string, unknown>;
};

export type DefaultTransportProperties = {
  synced: Promise<void>;
  handler: {
    start: () => Promise<Message>;
  };
};

export const teleportalEventClient = new EventClient<{
  "teleportal-provider:load-subdoc": {
    subdoc: Y.Doc;
    provider: Provider<any, any>;
    document: string;
    parentDoc: Y.Doc;
  };
  "teleportal-provider:unload-subdoc": {
    subdoc: Y.Doc;
    provider: Provider<any, any>;
    document: string;
    parentDoc: Y.Doc;
  };
  "teleportal-provider:received-message": {
    message: RawReceivedMessage;
    provider: Provider<any, any>;
    connection: Connection;
  };
  "teleportal-provider:sent-message": {
    message: Message;
    provider: Provider<any, any>;
    connection: Connection;
  };
  "teleportal-provider:connected": {
    provider: Provider<any, any>;
    connection: Connection;
  };
  "teleportal-provider:disconnected": {
    provider: Provider<any, any>;
    connection: Connection;
  };
  "teleportal-provider:update": {
    state: ConnectionState;
    provider: Provider<any, any>;
    connection: Connection;
  };
}>({
  pluginId: "teleportal-provider",
});

export type ProviderOptions<
  T extends Transport<ClientContext, DefaultTransportProperties> = Transport<
    ClientContext,
    DefaultTransportProperties
  >,
  R extends RpcExtensionMap = {},
> = {
  connection: Connection;
  document: string;
  ydoc?: Y.Doc;
  awareness?: Awareness;
  enableOfflinePersistence?: boolean;
  indexedDBPrefix?: string;
  encryptionKey?: CryptoKey;
  rpc?: R;
  getTransport?: (ctx: {
    ydoc: Y.Doc;
    document: string;
    awareness: Awareness;
    getDefaultTransport(): Transport<ClientContext, DefaultTransportProperties>;
  }) => T;
};

type ProviderEvents = {
  "load-subdoc": (ctx: {
    subdoc: Y.Doc;
    provider: Provider<any, any>;
    document: string;
    parentDoc: Y.Doc;
  }) => void;
  "unload-subdoc": (ctx: {
    subdoc: Y.Doc;
    provider: Provider<any, any>;
    document: string;
    parentDoc: Y.Doc;
  }) => void;
  "received-message": (message: RawReceivedMessage) => void;
  "sent-message": (message: Message) => void;
  connected: () => void;
  disconnected: () => void;
  update: (state: ConnectionState) => void;
  "peer-join": (peer: PresenceEvent) => void;
  "peer-leave": (peer: PresenceEvent) => void;
};

export class Provider<
  T extends Transport<ClientContext, DefaultTransportProperties> = Transport<
    ClientContext,
    DefaultTransportProperties
  >,
  R extends RpcExtensionMap = {},
> extends Observable<ProviderEvents> {
  public doc: Y.Doc;
  public awareness: Awareness;
  public transport: T;
  public document: string;
  public encryptionKey?: CryptoKey;
  public subdocs: Map<string, Provider<any, any>> = new Map();
  public rpc: RpcNamespace<R>;

  #connection: Connection;
  #messageReader: FanOutReader<RawReceivedMessage>;
  #getTransport: ProviderOptions<T, R>["getTransport"];
  #rpcClient: RpcClient;
  #extensions: RpcExtension<any>[] = [];
  #rpcOptions?: R;

  // Offline persistence
  #localPersistence?: IndexeddbPersistence;
  #enableOfflinePersistence: boolean;
  #indexedDBPrefix: string;
  #localLoaded = false;

  #abortController = new AbortController();
  #initInProgress = false;
  #syncBridgeRegistered = false;

  constructor({
    connection,
    document,
    ydoc = new Y.Doc(),
    awareness = new Awareness(ydoc),
    getTransport = ({ getDefaultTransport }) => getDefaultTransport() as T,
    enableOfflinePersistence = true,
    indexedDBPrefix = "teleportal-",
    encryptionKey,
    rpc,
  }: ProviderOptions<T, R>) {
    super();
    this.doc = ydoc;
    this.awareness = awareness;
    this.document = document;
    this.#getTransport = getTransport;
    this.#enableOfflinePersistence = enableOfflinePersistence;
    this.#indexedDBPrefix = indexedDBPrefix;
    this.encryptionKey = encryptionKey;
    this.#rpcOptions = rpc;
    this.transport = getTransport({
      ydoc,
      document,
      awareness,
      getDefaultTransport: () => {
        if (encryptionKey) {
          const handler = new EncryptionClient({
            document,
            ydoc,
            awareness,
            key: encryptionKey,
          });
          return getEncryptedTransport(handler) as unknown as Transport<
            ClientContext,
            DefaultTransportProperties
          >;
        }
        return getYTransportFromYDoc({ ydoc, document, awareness });
      },
    });
    this.#connection = connection;
    this.#messageReader = this.#connection.getReader();
    this.#rpcClient = new RpcClient(connection);

    // Initialize RPC extensions
    this.rpc = {} as RpcNamespace<R>;
    if (rpc) {
      this.#initExtensions(rpc);
    }

    // Pipe transport ↔ connection
    this.transport.readable.pipeTo(
      new WritableStream({
        write: (message) => {
          this.#connection.send(message);
        },
      }),
    );
    this.#messageReader.readable.pipeTo(this.transport.writable);

    this.doc.on("subdocs", this.#subdocListener);

    if (this.#enableOfflinePersistence) {
      this.#initOfflinePersistence();
    }

    if (connection.state.type === "connected") {
      this.#init();
    }

    // Event forwarding
    const signal = this.#abortController.signal;
    signal.addEventListener("abort", connection.on("connected", this.#init));
    signal.addEventListener(
      "abort",
      connection.on("connected", () => {
        this.call("connected");
        teleportalEventClient.emit("teleportal-provider:connected", {
          provider: this,
          connection,
        });
      }),
    );
    signal.addEventListener(
      "abort",
      connection.on("disconnected", () => {
        this.call("disconnected");
        teleportalEventClient.emit("teleportal-provider:disconnected", {
          provider: this,
          connection,
        });
      }),
    );
    signal.addEventListener(
      "abort",
      connection.on("received-message", (message) => {
        this.call("received-message", message);
        teleportalEventClient.emit("teleportal-provider:received-message", {
          message,
          provider: this,
          connection,
        });
        if (message.type === "presence") {
          this.#handlePresenceMessage(message as PresenceMessage<any>);
        }
      }),
    );
    signal.addEventListener(
      "abort",
      connection.on("sent-message", (message) => {
        this.call("sent-message", message);
        teleportalEventClient.emit("teleportal-provider:sent-message", {
          message,
          provider: this,
          connection,
        });
      }),
    );
    signal.addEventListener(
      "abort",
      connection.on("update", (state) => {
        this.call("update", state);
        teleportalEventClient.emit("teleportal-provider:update", {
          state,
          provider: this,
          connection,
        });
      }),
    );

    // Route RPC/ACK messages to extensions
    signal.addEventListener(
      "abort",
      connection.on("received-message", async (message) => {
        if (message.type === "rpc") {
          for (const ext of this.#extensions) {
            if (ext.handleMessage && (await ext.handleMessage(message as any))) return;
          }
        } else if (message.type === "ack") {
          for (const ext of this.#extensions) {
            if (ext.handleAck && (await ext.handleAck(message as any))) return;
          }
        }
      }),
    );
  }

  // --- RPC Extension initialization ---

  #initExtensions(rpcMap: R) {
    // Re-read the provider's synced getter on each access so extensions get
    // the current promise (it is re-created after disconnect/reconnect).
    const getSynced = () => this.synced;
    const ctx: RpcExtensionContext = {
      rpcClient: this.#rpcClient,
      document: this.document,
      doc: this.doc,
      awareness: this.awareness,
      encryptionKey: this.encryptionKey,
      connection: this.#connection,
      get synced() {
        return getSynced();
      },
    };

    for (const [name, factory] of Object.entries(rpcMap)) {
      const extension = factory();
      const api = extension.create(ctx);
      (this.rpc as any)[name] = api;
      this.#extensions.push(extension);
    }
  }

  // --- Presence handling ---

  #handlePresenceMessage(message: PresenceMessage<any>) {
    const payload = message.payload;
    if (payload.type === "presence-announce" || payload.type === "presence-heartbeat") return;

    const peer: PresenceEvent = {
      awarenessId: payload.awarenessId,
      clientId: payload.clientId,
      userId: payload.userId,
      data: payload.data,
    };
    if (payload.type === "presence-leave") {
      removeAwarenessStates(this.awareness, [payload.awarenessId], "presence");
      this.call("peer-leave", peer);
    } else {
      this.call("peer-join", peer);
    }
  }

  // --- Offline persistence ---

  #initOfflinePersistence() {
    if (!this.#enableOfflinePersistence || globalThis.window === undefined) return;
    const key = `${this.#indexedDBPrefix}${this.document}`;
    try {
      this.#localPersistence = new IndexeddbPersistence(key, this.doc);
      this.#localPersistence.on("synced", () => {
        this.#localLoaded = true;
      });
    } catch {
      this.#enableOfflinePersistence = false;
    }
  }

  // --- Init (on connect) ---

  #init = async () => {
    if (this.#initInProgress) return;
    this.#initInProgress = true;
    try {
      this.#connection.send(await this.transport.handler.start());
      this.#connection.send(
        new PresenceMessage(this.document, {
          type: "presence-announce",
          awarenessId: this.awareness.clientID,
        }),
      );

      // Bridge connection state → doc "sync" events. Registered once: #init
      // runs on every (re)connect, so registering here unguarded would leak a
      // new listener pair per reconnect and emit duplicate "sync" events.
      if (!this.#syncBridgeRegistered) {
        this.#syncBridgeRegistered = true;
        const signal = this.#abortController.signal;
        signal.addEventListener(
          "abort",
          this.#connection.on("disconnected", () => {
            this.doc.emit("sync", [false, this.doc]);
          }),
        );
        signal.addEventListener(
          "abort",
          this.#connection.on("connected", () => {
            this.doc.emit("sync", [true, this.doc]);
          }),
        );
        this.transport.synced
          .then(() => this.doc.emit("sync", [true, this.doc]))
          .catch(() => this.doc.emit("sync", [false, this.doc]));
      }
    } catch (error) {
      console.error("Failed to send sync-step-1", error);
    } finally {
      this.#initInProgress = false;
    }
  };

  // --- Subdocs ---

  #subdocListener = ({ loaded, removed }: { loaded: Set<Y.Doc>; removed: Set<Y.Doc> }) => {
    for (const doc of loaded) {
      if (this.subdocs.has(doc.guid)) continue;
      const provider = this.openDocument({
        document: this.document + "/" + doc.guid,
        ydoc: doc,
        awareness: this.awareness,
        getTransport: this.#getTransport as any,
      });
      this.subdocs.set(doc.guid, provider);
      const ctx = {
        subdoc: doc,
        provider,
        document: this.document,
        parentDoc: this.doc,
      };
      this.call("load-subdoc", ctx);
      teleportalEventClient.emit("teleportal-provider:load-subdoc", ctx);
    }
    for (const doc of removed) {
      const provider = this.subdocs.get(doc.guid);
      if (!provider) continue;
      provider.destroy({ destroyConnection: false });
      this.subdocs.delete(doc.guid);
      const ctx = {
        subdoc: doc,
        provider,
        document: this.document,
        parentDoc: this.doc,
      };
      this.call("unload-subdoc", ctx);
      teleportalEventClient.emit("teleportal-provider:unload-subdoc", ctx);
    }
  };

  // --- Synced / loaded ---

  #synced: Promise<void> | null = null;
  #syncedUnsubscribe: (() => void) | null = null;
  #loaded: Promise<void> | null = null;

  public get loaded(): Promise<void> {
    if (this.#loaded) return this.#loaded;
    if (this.#enableOfflinePersistence && this.#localPersistence) {
      this.#loaded = new Promise<void>((resolve) => {
        if (this.#localLoaded) {
          resolve();
        } else {
          this.#localPersistence!.once("synced", () => resolve());
        }
      });
      return this.#loaded;
    }
    this.#loaded = this.synced;
    return this.#loaded;
  }

  public get synced(): Promise<void> {
    if (this.#synced) return this.#synced;

    const synced = Promise.all([
      this.#connection.connected,
      this.transport.synced,
      this.#waitForInFlightMessages(),
    ]).then(() => {});

    this.#synced = synced;
    this.#syncedUnsubscribe = this.#connection.on("update", (state) => {
      if (state.type === "disconnected" || state.type === "errored") {
        this.#clearSyncedPromise();
      }
    });
    return synced;
  }

  #clearSyncedPromise() {
    if (this.#syncedUnsubscribe) {
      this.#syncedUnsubscribe();
      this.#syncedUnsubscribe = null;
    }
    this.#synced = null;
  }

  #waitForInFlightMessages(): Promise<void> {
    return new Promise((resolve) => {
      if (this.#connection.inFlightMessageCount === 0) {
        resolve();
        return;
      }
      let unsubscribe: (() => void) | null = null;
      let resolved = false;
      unsubscribe = this.#connection.on("messages-in-flight", (hasInFlight) => {
        if (!resolved && !hasInFlight) {
          resolved = true;
          if (unsubscribe) unsubscribe();
          resolve();
        }
      });
    });
  }

  // --- Public getters ---

  public get state() {
    return this.#connection.state;
  }

  public get connection() {
    return this.#connection;
  }

  // --- Document switching ---

  public switchDocument(options: Omit<ProviderOptions<T, R>, "connection">): Provider<T, R> {
    this.destroy({ destroyConnection: false });
    return this.openDocument(options);
  }

  public openDocument(options: Omit<ProviderOptions<T, R>, "connection">): Provider<T, R> {
    const doc = options.ydoc ?? new Y.Doc();
    const awareness = options.awareness ?? new Awareness(doc);
    return new Provider<T, R>({
      connection: this.#connection,
      ydoc: doc,
      awareness,
      getTransport: options.getTransport ?? (this.#getTransport as any),
      enableOfflinePersistence: options.enableOfflinePersistence ?? this.#enableOfflinePersistence,
      indexedDBPrefix: options.indexedDBPrefix ?? this.#indexedDBPrefix,
      encryptionKey: options.encryptionKey ?? this.encryptionKey,
      rpc: options.rpc ?? this.#rpcOptions,
      document: options.document,
    });
  }

  // --- Destroy ---

  public destroy({
    destroyConnection = true,
    destroyDoc = true,
  }: {
    destroyConnection?: boolean;
    destroyDoc?: boolean;
  } = {}) {
    this.doc.off("subdocs", this.#subdocListener);
    super.destroy();

    if (this.#localPersistence) {
      this.#localPersistence.destroy();
      this.#localPersistence = undefined;
    }

    if (!this.#abortController.signal.aborted) {
      this.#abortController.abort();
    }

    this.#clearSyncedPromise();

    try {
      this.transport.readable.cancel().catch(() => {});
      this.transport.writable.close().catch(() => {});
    } catch {
      // ignore
    }

    this.#messageReader.unsubscribe();
    this.#rpcClient.destroy();

    // Destroy extensions
    for (const ext of this.#extensions) {
      if (ext.destroy) ext.destroy();
    }
    this.#extensions = [];

    if (destroyConnection) {
      this.#connection.destroy();
    }
    if (destroyDoc) {
      this.doc.destroy();
    }
  }

  public [Symbol.dispose]() {
    this.destroy();
  }

  // --- Static factory ---

  static async create<
    T extends Transport<ClientContext, DefaultTransportProperties> = Transport<
      ClientContext,
      DefaultTransportProperties
    >,
    R extends RpcExtensionMap = {},
  >(
    options: (
      | {
          url: string;
          connection?: undefined;
          token?: TokenOptions;
          transports?: ConnectionTransport[];
        }
      | { url?: undefined; connection: Connection }
    ) &
      Omit<ProviderOptions<T, R>, "connection">,
  ): Promise<Provider<T, R>> {
    const connection =
      options.connection ??
      new Connection({
        url: options.url!,
        transports: options.transports ?? [websocketTransport({ timeout: 5000 }), httpTransport()],
        token: "token" in options ? options.token : undefined,
      });

    await connection.connected;

    return new Provider({
      connection,
      ydoc: options.ydoc,
      document: options.document,
      awareness: options.awareness,
      getTransport: options.getTransport,
      enableOfflinePersistence: options.enableOfflinePersistence,
      indexedDBPrefix: options.indexedDBPrefix,
      encryptionKey: options.encryptionKey,
      rpc: options.rpc,
    });
  }
}
