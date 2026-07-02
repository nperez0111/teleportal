import { useEffect, useState } from "react";
import {
  Provider,
  DefaultTransportProperties,
  websocketTransport,
  httpTransport,
} from "teleportal/providers";
import type { Connection } from "teleportal/providers";
import { createMilestoneRpc } from "teleportal/protocols/milestone";
import { createAttributionRpc } from "teleportal/protocols/attribution";
import { createFileRpc } from "teleportal/protocols/file";
import { createKeyRegistryRpc } from "teleportal/protocols/key-registry";
import { registryKey, importWrappingKey } from "teleportal/encryption-key";
import { IdbFileCache } from "teleportal/storage";

import { getEncryptedTransport } from "./encrypted";

const fileCache = new IdbFileCache();
import { ClientContext, Transport } from "teleportal";
import { EncryptionClient } from "../../../src/transports/encrypted/client";
import { getIdentity } from "./identity";
import { createConnection } from "teleportal/providers/worker";

/**
 * The RPC extensions registered by the playground provider.
 */
export type PlaygroundRpcExtensions = {
  milestones: typeof createMilestoneRpc;
  attribution: typeof createAttributionRpc;
  files: () => ReturnType<typeof createFileRpc>;
  keys: typeof createKeyRegistryRpc;
};

/**
 * Fully-typed Provider used by the playground, including the transport
 * customisation (encrypted handler) and all registered RPC extensions.
 */
export type PlaygroundProvider = Provider<
  Transport<ClientContext, DefaultTransportProperties & { handler?: EncryptionClient }>,
  PlaygroundRpcExtensions
>;

async function fetchToken(userId: string): Promise<string> {
  const res = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  const { token } = await res.json();
  return token;
}

class ProviderManager {
  private static instance: ProviderManager | null = null;
  private provider: PlaygroundProvider | null = null;
  private connectionPromise: Promise<Connection> | null = null;
  private subscribers = new Set<(provider: PlaygroundProvider | null) => void>();

  private constructor() {}

  static getInstance(): ProviderManager {
    if (!ProviderManager.instance) {
      ProviderManager.instance = new ProviderManager();
    }
    return ProviderManager.instance;
  }

  private async getProviderConnection(): Promise<Connection> {
    if (!this.connectionPromise) {
      this.connectionPromise = fetchToken(getIdentity().name).then((token) =>
        createConnection({
          workerUrl: "/worker.js",
          url: `${window.location.protocol}//${window.location.host}/`,
          token: { token },
          transports: [websocketTransport({ timeout: 5000 }), httpTransport()],
        }),
      );
    }
    return this.connectionPromise;
  }

  async getProvider(
    documentId: string,
    key: CryptoKey | undefined,
    wrappingKeyString: string | undefined,
  ): Promise<PlaygroundProvider> {
    const useRegistry = Boolean(wrappingKeyString);

    const makeRpc = (resolvedKey: CryptoKey | undefined) => ({
      milestones: createMilestoneRpc,
      attribution: createAttributionRpc,
      files: () => createFileRpc({ encryptionKey: resolvedKey, cache: fileCache }),
      keys: createKeyRegistryRpc,
    });

    const makeTransport =
      (resolvedKey: CryptoKey | undefined) =>
      ({ document, ydoc, awareness, getDefaultTransport }: any) => {
        if (resolvedKey) {
          return getEncryptedTransport(resolvedKey)({ document, ydoc, awareness });
        }
        return getDefaultTransport();
      };

    if (!this.provider) {
      const connection = await this.getProviderConnection();

      if (useRegistry) {
        const resolver = registryKey({ wrappingKey: await importWrappingKey(wrappingKeyString!) });
        this.provider = (await Provider.create({
          connection,
          document: documentId,
          encryptionKey: resolver,
          rpc: makeRpc(undefined),
          enableOfflinePersistence: true,
        })) as PlaygroundProvider;
      } else {
        this.provider = (await Provider.create({
          connection,
          document: documentId,
          encryptionKey: key ?? false,
          rpc: makeRpc(key),
          getTransport: makeTransport(key),
          enableOfflinePersistence: true,
        })) as PlaygroundProvider;
      }
    } else {
      if (useRegistry) {
        this.provider.destroy({ destroyConnection: false });
        const connection = await this.getProviderConnection();
        const resolver = registryKey({ wrappingKey: await importWrappingKey(wrappingKeyString!) });
        this.provider = (await Provider.create({
          connection,
          document: documentId,
          encryptionKey: resolver,
          rpc: makeRpc(undefined),
          enableOfflinePersistence: true,
        })) as PlaygroundProvider;
      } else {
        this.provider = this.provider.switchDocument({
          document: documentId,
          encryptionKey: key ?? false,
          rpc: makeRpc(key),
          getTransport: makeTransport(key),
        });
      }
    }

    this.subscribers.forEach((callback) => callback(this.provider));
    return this.provider!;
  }

  subscribe(callback: (provider: PlaygroundProvider | null) => void): () => void {
    this.subscribers.add(callback);
    if (this.provider) {
      callback(this.provider);
    }
    return () => {
      this.subscribers.delete(callback);
    };
  }

  destroy(): void {
    if (this.provider) {
      this.provider.destroy({ destroyConnection: false });
      this.provider = null;
    }
    this.subscribers.clear();
  }
}

export function useProvider(
  documentId: string | null | undefined,
  key: CryptoKey | undefined,
  wrappingKey?: string,
): {
  provider: PlaygroundProvider | null;
} {
  const [provider, setProvider] = useState<PlaygroundProvider | null>(null);
  const providerManager = ProviderManager.getInstance();

  useEffect(() => {
    if (!documentId) {
      setProvider(null);
      return;
    }

    const unsubscribe = providerManager.subscribe(setProvider);
    providerManager.getProvider(documentId, key, wrappingKey).catch(console.error);

    return () => {
      unsubscribe();
    };
  }, [documentId, key, wrappingKey]);

  return {
    provider,
  };
}
