import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { ClientContext, Transport } from "teleportal";
import type { Connection } from "../types";
import { Provider, type DefaultTransportProperties, type ProviderOptions } from "../provider";
import type { RpcExtensionMap } from "../rpc-extension";
import type { KeyResolver } from "teleportal/encryption-key";
import type { AbstractDocumentStorage } from "teleportal/storage";
import { createConnection, type CreateConnectionOptions } from "./create-connection";

export type WorkerProviderOptions<
  T extends Transport<ClientContext, DefaultTransportProperties> = Transport<
    ClientContext,
    DefaultTransportProperties
  >,
  R extends RpcExtensionMap = {},
> = CreateConnectionOptions & {
  document: string;
  ydoc?: Y.Doc;
  awareness?: Awareness;
  enableOfflinePersistence?: boolean;
  indexedDBPrefix?: string;
  offlineStorage?: AbstractDocumentStorage;
  encryptionKey?: CryptoKey | false | KeyResolver;
  rpc?: R;
  getTransport?: ProviderOptions<T, R>["getTransport"];
};

export class WorkerProvider<
  T extends Transport<ClientContext, DefaultTransportProperties> = Transport<
    ClientContext,
    DefaultTransportProperties
  >,
  R extends RpcExtensionMap = {},
> {
  #provider: Provider<T, R>;
  #connection: Connection;

  private constructor(provider: Provider<T, R>, connection: Connection) {
    this.#provider = provider;
    this.#connection = connection;
  }

  static async create<
    T extends Transport<ClientContext, DefaultTransportProperties> = Transport<
      ClientContext,
      DefaultTransportProperties
    >,
    R extends RpcExtensionMap = {},
  >(options: WorkerProviderOptions<T, R>): Promise<WorkerProvider<T, R>> {
    const connection = createConnection(options);

    await connection.connected;

    let resolvedKey: CryptoKey | false | undefined;
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

    const provider = new Provider<T, R>({
      connection,
      document: options.document,
      ydoc: options.ydoc,
      awareness: options.awareness,
      enableOfflinePersistence: options.enableOfflinePersistence,
      indexedDBPrefix: options.indexedDBPrefix,
      offlineStorage: options.offlineStorage,
      encryptionKey: resolvedKey,
      rpc: options.rpc,
      getTransport: options.getTransport,
    });
    if (keyResolver) provider._keyResolver = keyResolver;

    return new WorkerProvider<T, R>(provider, connection);
  }

  // --- Proxied Provider API ---

  get doc(): Y.Doc {
    return this.#provider.doc;
  }

  get awareness(): Awareness {
    return this.#provider.awareness;
  }

  get transport(): T {
    return this.#provider.transport;
  }

  get document(): string {
    return this.#provider.document;
  }

  get encryptionKey(): CryptoKey | false | undefined {
    return this.#provider.encryptionKey;
  }

  get subdocs(): Map<string, Provider<any, any>> {
    return this.#provider.subdocs;
  }

  get rpc(): import("../rpc-extension").RpcNamespace<R> {
    return this.#provider.rpc;
  }

  get state() {
    return this.#provider.state;
  }

  get connection(): Connection {
    return this.#connection;
  }

  get synced(): Promise<void> {
    return this.#provider.synced;
  }

  get loaded(): Promise<void> {
    return this.#provider.loaded;
  }

  switchDocument(options: Omit<ProviderOptions<T, R>, "connection">): Provider<T, R> {
    return this.#provider.switchDocument(options);
  }

  openDocument(options: Omit<ProviderOptions<T, R>, "connection">): Provider<T, R> {
    return this.#provider.openDocument(options);
  }

  async openDocumentAsync(
    options: Omit<ProviderOptions<T, R>, "connection">,
  ): Promise<Provider<T, R>> {
    return this.#provider.openDocumentAsync(options);
  }

  on(event: string, callback: (...args: any[]) => void): () => void {
    return (this.#provider as any).on(event, callback);
  }

  async clearOfflineData(): Promise<void> {
    return this.#provider.clearOfflineData();
  }

  destroy({
    destroyConnection = true,
    destroyDoc = true,
  }: {
    destroyConnection?: boolean;
    destroyDoc?: boolean;
  } = {}) {
    this.#provider.destroy({ destroyConnection: false, destroyDoc });
    if (destroyConnection) {
      this.#connection.destroy();
    }
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
