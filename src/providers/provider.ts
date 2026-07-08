import { DevtoolsEventClient } from "./devtools-events";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  DocMessage,
  Message,
  Observable,
  PresenceMessage,
  RawReceivedMessage,
  type ClientContext,
  type Transport,
  type VersionedUpdate,
} from "teleportal";
import {
  getYTransportFromYDoc,
  getEncryptedTransport,
  EncryptionClient,
  createSerialQueue,
  connect,
  forEachMessage,
  type SerialQueue,
  type FanOutReader,
} from "teleportal/transports";
import type { AbstractDocumentStorage } from "teleportal/storage";
import { IdbDocumentStorage } from "../storage/idb/document-storage";
import { DirectConnection } from "./connection";
import type { Connection, ConnectionState } from "./types";
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
import type { KeyResolver } from "teleportal/encryption-key";

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

type TeleportalEventMap = {
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
};

export const teleportalEventClient: DevtoolsEventClient<TeleportalEventMap> =
  new DevtoolsEventClient("teleportal-provider");

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
  /**
   * Override the local offline storage backend. Defaults to `IdbDocumentStorage`
   * (IndexedDB-backed). Pass any `AbstractDocumentStorage` implementation for
   * testing or custom backends.
   */
  offlineStorage?: AbstractDocumentStorage;
  /**
   * The key used for end-to-end content encryption.
   *
   * End-to-end encryption is the default: pass a {@link CryptoKey} (created via
   * `createEncryptionKey`/`importEncryptionKey` from `teleportal/encryption-key`)
   * to encrypt document content. Omitting this throws — to deliberately run an
   * unencrypted document, pass `false`.
   *
   * A {@link KeyResolver} can be passed to resolve the key asynchronously —
   * it will be resolved inside `Provider.create` after the connection is ready.
   * Use `passwordKey()` or `registryKey()` from `teleportal/encryption-key`.
   */
  encryptionKey?: CryptoKey | false | KeyResolver;
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
  public transport!: T;
  public document: string;
  public encryptionKey?: CryptoKey | false;
  public subdocs: Map<string, Provider<any, any>> = new Map();
  public rpc: RpcNamespace<R>;

  _keyResolver?: KeyResolver;

  #connection!: Connection;
  #messageReader!: FanOutReader<RawReceivedMessage>;
  #getTransport: ProviderOptions<T, R>["getTransport"];
  #rpcClient: RpcClient;
  #extensions: RpcExtension<any>[] = [];
  #rpcOptions?: R;

  // Offline persistence
  #localStorage?: AbstractDocumentStorage;
  #enableOfflinePersistence: boolean;
  #indexedDBPrefix: string;
  #localReplayed: Promise<void> = Promise.resolve();
  #applyQueue: SerialQueue<RawReceivedMessage> | null = null;
  #lastApplyPromise: Promise<void> = Promise.resolve();

  #abortController = new AbortController();
  #initInProgress = false;
  #syncBridgeRegistered = false;

  // Pending-structs detector state (self-healing resync)
  #pendingStructsParked = false;
  #pendingStructsTimer: ReturnType<typeof setInterval> | null = null;

  constructor({
    connection,
    document,
    ydoc = new Y.Doc(),
    awareness = new Awareness(ydoc),
    getTransport = ({ getDefaultTransport }) => getDefaultTransport() as T,
    enableOfflinePersistence = true,
    indexedDBPrefix = "teleportal-",
    offlineStorage,
    encryptionKey,
    rpc,
  }: ProviderOptions<T, R>) {
    super();
    // End-to-end encryption is the default. Omitting `encryptionKey` is almost
    // always a mistake (the server enforces that all clients of a document agree
    // on encryption, so a keyless client would be rejected), so fail loudly.
    // To deliberately run an unencrypted document, pass `encryptionKey: false`.
    // This must live in the constructor — not in `getDefaultTransport` — so a
    // custom `getTransport` cannot silently bypass the requirement.
    if (encryptionKey === undefined) {
      throw new Error(
        `Provider for document "${document}" was created without an encryptionKey. ` +
          `End-to-end encryption is required by default — pass an encryptionKey ` +
          `(a CryptoKey from teleportal/encryption-key), or explicitly opt out of ` +
          `encryption with \`encryptionKey: false\`.`,
      );
    }
    if (encryptionKey && typeof encryptionKey === "object" && "resolve" in encryptionKey) {
      throw new Error(
        `Provider for document "${document}" received a KeyResolver in the sync constructor. ` +
          `KeyResolvers must be resolved before construction — use Provider.create() instead.`,
      );
    }
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
        // A CryptoKey selects the content-encryption transport; `false` is the
        // explicit opt-out into a plaintext transport. (`undefined` is already
        // rejected in the constructor above, so it never reaches here.)
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

    // Pipe transport source → connection (outbound)
    void forEachMessage(this.transport.source, (message) => {
      this.#persistDocMessage(message);
      this.#connection.send(message);
    });

    if (this.#enableOfflinePersistence) {
      this.#applyQueue = createSerialQueue<RawReceivedMessage>((msg) => this.transport.write(msg));
      void forEachMessage(this.#messageReader.source, (chunk) => {
        this.#persistDocMessage(chunk);
        this.#lastApplyPromise = this.#applyQueue!.enqueue(chunk);
      });
      this.#initOfflinePersistence(offlineStorage);
    } else {
      void connect(this.#messageReader.source, this.transport);
    }

    this.doc.on("subdocs", this.#subdocListener);

    // Poll for parked pending structs: a lost inbound update leaves a
    // dependency gap and Y.js silently parks every later update in
    // `store.pendingStructs` (no doc event fires), so a poller is the only
    // reliable transition detector. Cleared in destroy(); unref'd so it never
    // keeps a non-browser process alive.
    this.#pendingStructsTimer = setInterval(this.#checkPendingStructs, 1000);
    (this.#pendingStructsTimer as unknown as { unref?: () => void }).unref?.();

    if (connection.state.type === "connected") {
      this.#init();
    }

    // Event forwarding
    const signal = this.#abortController.signal;
    signal.addEventListener("abort", connection.on("connected", this.#init));
    // A permanent server rejection of one of OUR doc messages means the
    // server (and every peer) is missing that content while later updates
    // pile up on the gap. The rejected message itself must not be
    // retransmitted verbatim (it would fail again), but a resync re-uploads
    // the same content as a fresh diff against the server's state vector —
    // usually merged smaller — healing the divergence.
    signal.addEventListener(
      "abort",
      connection.on("diagnostic", (event) => {
        if (event.type === "message-rejected" && event.document === this.document) {
          this.#resync();
        }
      }),
    );
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
        // File-chunk stream messages stay off the devtools pipeline, mirroring
        // the send side (Connection.sendStream): retaining megabyte chunk
        // payloads per message would pin whole files in devtools memory.
        // Transfers are observed via the file protocol's progress events.
        if (
          message.type !== "rpc" ||
          (message as { requestType?: string }).requestType !== "stream"
        ) {
          teleportalEventClient.emit("teleportal-provider:received-message", {
            message,
            provider: this,
            connection,
          });
        }
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
      // `false` is the plaintext opt-out; extensions only care about a real key.
      encryptionKey: this.encryptionKey || undefined,
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
    if (
      payload.type === "presence-announce" ||
      payload.type === "presence-unannounce" ||
      payload.type === "presence-heartbeat"
    )
      return;
    if (payload.awarenessId === this.awareness.clientID) return;

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

  // --- Pending-structs detector + self-healing resync ---

  #pendingStructsParkedSince = 0;
  #lastParkedResyncAt = 0;

  /**
   * Smoking-gun signal for a lost update: when an inbound update depends on
   * one that never arrived, Y.js parks it (and everything after it) in
   * `store.pendingStructs` — edits stop propagating while the connection
   * looks healthy, and NOTHING else in the pipeline notices (Y.js parks
   * silently, no doc event fires).
   *
   * Detection alone isn't enough: without intervention the doc stays parked
   * until the missing update happens to arrive or the connection resyncs on
   * reconnect. So when a park persists across polls while connected, send a
   * fresh sync-step-1 — the server replies with the diff against our state
   * vector, which contains the missing range and un-parks everything.
   * Cooldown prevents resync storms when the server itself lacks the update
   * (e.g. the sender's message was lost server-side; only the sender's own
   * resync can heal that case).
   */
  #checkPendingStructs = () => {
    const store = this.doc.store as unknown as {
      pendingStructs: { missing: Map<number, number>; update: Uint8Array } | null;
      pendingDs: Uint8Array | null;
    };
    const pending = store.pendingStructs;
    const parked = pending !== null;
    const now = Date.now();
    if (parked && !this.#pendingStructsParked) {
      this.#pendingStructsParkedSince = now;
    }
    this.#pendingStructsParked = parked;

    if (
      parked &&
      now - this.#pendingStructsParkedSince >= 2000 &&
      now - this.#lastParkedResyncAt >= 10_000 &&
      this.#connection.state.type === "connected"
    ) {
      this.#lastParkedResyncAt = now;
      this.#resync();
    }
  };

  /**
   * Re-run the sync handshake for this document on the live connection:
   * sync-step-1 with our current state vector, to which the server replies
   * with exactly the range we're missing. Safe to call repeatedly — the
   * exchange is idempotent.
   */
  #resync(): void {
    void this.transport.handler
      .start()
      .then((msg) => this.#connection.send(msg))
      .catch(() => {
        // Connection dropped mid-resync — the reconnect handshake resyncs.
      });
  }

  // --- Offline persistence ---

  #initOfflinePersistence(injectedStorage?: AbstractDocumentStorage) {
    if (!this.#enableOfflinePersistence) return;
    if (!injectedStorage && (globalThis.window === undefined || typeof indexedDB === "undefined"))
      return;
    try {
      const encrypted = this.encryptionKey !== false;
      this.#localStorage =
        injectedStorage ??
        new IdbDocumentStorage(`${this.#indexedDBPrefix}${this.document}`, encrypted);
      this.#localReplayed = this.#replayFromLocalStorage();
    } catch {
      this.#enableOfflinePersistence = false;
    }
  }

  async #replayFromLocalStorage(): Promise<void> {
    try {
      const storage = this.#localStorage;
      if (!storage) return;
      const doc = await storage.getDocument(this.document);
      if (!doc?.content.update) return;
      const encrypted = this.encryptionKey !== false;
      const replayMsg = new DocMessage(
        this.document,
        {
          type: "sync-step-2" as const,
          update: { version: 2, data: doc.content.update } as any,
        },
        { clientId: this.awareness.clientID.toString() },
        encrypted,
      );
      if (this.#applyQueue) {
        // enqueue resolves only after the transport has applied the replayed
        // update to the doc, so #init's sync-step-1 state vector reflects the
        // locally-restored state.
        await this.#applyQueue.enqueue(replayMsg as RawReceivedMessage);
      }
    } catch {
      // Replay failed — fall back to empty-doc sync.
    }
  }

  #persistDocMessage(message: Message | RawReceivedMessage): void {
    if (!this.#localStorage) return;
    if (message.type !== "doc") return;
    const payload = (message as DocMessage<any>).payload;
    if (payload.type !== "update" && payload.type !== "sync-step-2") return;
    const update = payload.update as VersionedUpdate;
    this.#localStorage.handleUpdate(this.document, update).catch(() => {});
  }

  // --- Init (on connect) ---

  #init = async () => {
    if (this.#initInProgress) return;
    this.#initInProgress = true;
    try {
      if (this.#enableOfflinePersistence && this.#localStorage) {
        // Wait for local replay so the sync-step-1 state vector reflects
        // locally-restored state. Timeout prevents a failed replay from deadlocking.
        await Promise.race([this.#localReplayed, new Promise<void>((r) => setTimeout(r, 5000))]);
      }
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
        // `encryptionKey` is intentionally omitted so the subdoc inherits the
        // parent's encryption mode (key or `false`) via openDocument's `??`.
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
    if (this.#enableOfflinePersistence && this.#localStorage) {
      this.#loaded = this.#localReplayed;
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
    // `destroy()` abandons this promise via `#clearSyncedPromise()` while
    // `transport.synced` is still pending, so it rejects ("YDoc cancelled")
    // with no internal awaiter. Swallow that here; consumers that await the
    // returned promise still observe the rejection on their own derived chain.
    synced.catch(() => {});

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

  #waitForApplyQueue(): Promise<void> {
    if (!this.#applyQueue) {
      return Promise.resolve();
    }
    // Wait for the last enqueued item to finish processing
    return this.#lastApplyPromise;
  }

  // --- Public getters ---

  public get state() {
    return this.#connection.state;
  }

  public get connection() {
    return this.#connection;
  }

  // --- Flush ---

  /**
   * Wait for all pending messages (both outbound and inbound) to be processed.
   *
   * Resolves immediately if no messages are pending. Useful for clean shutdown
   * patterns where you want to ensure all data is sent before calling destroy().
   *
   * @param timeout Maximum time to wait in milliseconds (default: 500ms)
   * @returns Promise that resolves when all messages are flushed, or rejects on timeout
   *
   * @example
   * ```ts
   * // Clean shutdown
   * await provider.flush(1000); // Wait up to 1 second
   * provider.destroy();
   * ```
   */
  public async flush(timeout: number = 500): Promise<void> {
    const flushPromise = Promise.all([
      this.#waitForInFlightMessages(),
      this.#waitForApplyQueue(),
    ]).then(() => {});

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`Flush timeout after ${timeout}ms`)), timeout);
    });

    return Promise.race([flushPromise, timeoutPromise]);
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
      // Inherit the parent's encryption mode unless explicitly overridden.
      // `??` is deliberate: an explicit `false` override is non-nullish so it
      // takes effect, while omitting the option inherits the parent's key/`false`
      // (never `undefined`, since the parent was successfully constructed).
      // KeyResolvers are not supported in the sync openDocument — use
      // openDocumentAsync instead.
      encryptionKey: (options.encryptionKey ?? this.encryptionKey) as CryptoKey | false | undefined,
      rpc: options.rpc ?? this.#rpcOptions,
      document: options.document,
    });
  }

  /**
   * Open a new document on the same connection, resolving a `KeyResolver` if
   * the parent was created with one. Use this instead of `openDocument` when
   * the encryption key needs async resolution per document.
   */
  public async openDocumentAsync(
    options: Omit<ProviderOptions<T, R>, "connection">,
  ): Promise<Provider<T, R>> {
    let resolvedKey: CryptoKey | false | undefined;
    const ek = options.encryptionKey;
    if (ek && typeof ek === "object" && "resolve" in ek) {
      resolvedKey = await ek.resolve({
        document: options.document,
        connection: this.#connection,
      });
    } else if (this._keyResolver && ek === undefined) {
      resolvedKey = await this._keyResolver.resolve({
        document: options.document,
        connection: this.#connection,
      });
    } else {
      resolvedKey = (ek ?? this.encryptionKey) as CryptoKey | false | undefined;
    }

    const doc = options.ydoc ?? new Y.Doc();
    const awareness = options.awareness ?? new Awareness(doc);
    const provider = new Provider<T, R>({
      connection: this.#connection,
      ydoc: doc,
      awareness,
      getTransport: options.getTransport ?? (this.#getTransport as any),
      enableOfflinePersistence: options.enableOfflinePersistence ?? this.#enableOfflinePersistence,
      indexedDBPrefix: options.indexedDBPrefix ?? this.#indexedDBPrefix,
      encryptionKey: resolvedKey,
      rpc: options.rpc ?? this.#rpcOptions,
      document: options.document,
    });
    if (this._keyResolver) provider._keyResolver = this._keyResolver;
    return provider;
  }

  // --- Destroy ---

  public destroy({
    destroyConnection = true,
    destroyDoc = true,
  }: {
    destroyConnection?: boolean;
    destroyDoc?: boolean;
  } = {}) {
    // Best-effort: retract our awareness presence so the server can notify
    // peers immediately instead of waiting for the connection to close.
    // send() is async, so guard against both synchronous throws and async
    // rejections (the connection may already be torn down).
    try {
      void this.#connection
        .send(
          new PresenceMessage(this.document, {
            type: "presence-unannounce",
            awarenessId: this.awareness.clientID,
          }),
        )
        .catch(() => {});
    } catch {
      // Connection may already be torn down
    }

    this.doc.off("subdocs", this.#subdocListener);
    if (this.#pendingStructsTimer !== null) {
      clearInterval(this.#pendingStructsTimer);
      this.#pendingStructsTimer = null;
    }
    super.destroy();

    if (this.#localStorage) {
      if (this.#localStorage instanceof IdbDocumentStorage) {
        (this.#localStorage as IdbDocumentStorage).close();
      }
      this.#localStorage = undefined;
    }

    if (!this.#abortController.signal.aborted) {
      this.#abortController.abort();
    }

    this.#clearSyncedPromise();
    this.#applyQueue?.close();

    try {
      this.transport.close();
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

  public async clearOfflineData(): Promise<void> {
    if (this.#localStorage) {
      await this.#localStorage.deleteDocument(this.document);
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
      new DirectConnection({
        url: options.url!,
        transports: options.transports ?? [websocketTransport({ timeout: 5000 }), httpTransport()],
        token: "token" in options ? options.token : undefined,
      });

    await connection.connected;

    let resolvedKey: CryptoKey | false | undefined = undefined;
    let keyResolver: KeyResolver | undefined;
    const ek = options.encryptionKey;

    if (ek && typeof ek === "object" && "resolve" in ek) {
      keyResolver = ek;
      resolvedKey = await keyResolver.resolve({
        document: options.document,
        connection,
      });
    } else {
      resolvedKey = ek as CryptoKey | false | undefined;
    }

    const provider = new Provider({
      connection,
      ydoc: options.ydoc,
      document: options.document,
      awareness: options.awareness,
      getTransport: options.getTransport,
      enableOfflinePersistence: options.enableOfflinePersistence,
      indexedDBPrefix: options.indexedDBPrefix,
      offlineStorage: options.offlineStorage,
      encryptionKey: resolvedKey,
      rpc: options.rpc,
    });
    if (keyResolver) provider._keyResolver = keyResolver;
    return provider;
  }
}
