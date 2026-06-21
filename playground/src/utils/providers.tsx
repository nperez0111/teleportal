import { useEffect, useState } from "react";
import {
  Provider,
  DefaultTransportProperties,
  Connection,
  websocketTransport,
  httpTransport,
} from "teleportal/providers";
import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";
import { createMilestoneRpc } from "teleportal/protocols/milestone";
import { createAttributionRpc } from "teleportal/protocols/attribution";
import { createFileRpc } from "teleportal/protocols/file";

import { getEncryptedTransport } from "./encrypted";
import { ClientContext, Transport } from "teleportal";
import { EncryptionClient } from "../../../src/transports/encrypted/client";
import { getIdentity } from "./identity";

/**
 * The RPC extensions registered by the playground provider.
 */
export type PlaygroundRpcExtensions = {
  milestones: typeof createMilestoneRpc;
  attribution: typeof createAttributionRpc;
  files: () => ReturnType<typeof createFileRpc>;
};

/**
 * Fully-typed Provider used by the playground, including the transport
 * customisation (encrypted handler) and all registered RPC extensions.
 */
export type PlaygroundProvider = Provider<
  Transport<ClientContext, DefaultTransportProperties & { handler?: EncryptionClient }>,
  PlaygroundRpcExtensions
>;

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

// Singleton provider manager to ensure only one provider instance exists (workaround for strict mode)
class ProviderManager {
  private static instance: ProviderManager | null = null;
  private provider: PlaygroundProvider | null = null;
  private websocketConnection: Promise<Connection> | null = null;
  private subscribers = new Set<(provider: PlaygroundProvider | null) => void>();

  private constructor() {}

  static getInstance(): ProviderManager {
    if (!ProviderManager.instance) {
      ProviderManager.instance = new ProviderManager();
    }
    return ProviderManager.instance;
  }

  private async getProviderConnection(): Promise<Connection> {
    if (!this.websocketConnection) {
      this.websocketConnection = tokenManager
        .createToken(
          // The token subject becomes the authenticated userId, which the server
          // records as the author of every edit from this tab.
          getIdentity().name,
          "docs",
          // TODO probably make token gen configurable callback
          new DocumentAccessBuilder()
            .admin("*")
            // .write("Testy")
            // .readOnly("test-this")
            .build(),
        )
        .then((token) => {
          return new Connection({
            url: `${window.location.protocol}//${window.location.host}/?token=${token}`,
            transports: [websocketTransport({ timeout: 5000 }), httpTransport()],
          });
        });
    }
    return this.websocketConnection;
  }

  async getProvider(documentId: string, key: CryptoKey | undefined): Promise<PlaygroundProvider> {
    if (!this.provider) {
      const connection = await this.getProviderConnection();
      this.provider = (await Provider.create({
        connection,
        document: documentId,
        encryptionKey: key,
        rpc: {
          milestones: createMilestoneRpc,
          attribution: createAttributionRpc,
          files: () => createFileRpc({ encryptionKey: key }),
        },
        getTransport: ({ document, ydoc, awareness, getDefaultTransport }) => {
          const baseTransport = key
            ? getEncryptedTransport(key)({ document, ydoc, awareness })
            : getDefaultTransport();
          return baseTransport as any;
        },
        enableOfflinePersistence: false,
      })) as PlaygroundProvider;
    } else {
      // Switch document on existing provider
      this.provider = this.provider.switchDocument({
        document: documentId,
        encryptionKey: key,
        rpc: {
          milestones: createMilestoneRpc,
          attribution: createAttributionRpc,
          files: () => createFileRpc({ encryptionKey: key }),
        },
        getTransport: ({ document, ydoc, awareness, getDefaultTransport }) => {
          const baseTransport = key
            ? getEncryptedTransport(key)({ document, ydoc, awareness })
            : getDefaultTransport();
          return baseTransport as any;
        },
      });
    }

    // Notify all subscribers
    this.subscribers.forEach((callback) => callback(this.provider));
    return this.provider!;
  }

  subscribe(callback: (provider: PlaygroundProvider | null) => void): () => void {
    this.subscribers.add(callback);
    // Immediately call with current provider if it exists
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

    // Subscribe to provider updates
    const unsubscribe = providerManager.subscribe(setProvider);

    // Get or create the provider
    providerManager.getProvider(documentId, key).catch(console.error);

    return () => {
      unsubscribe();
    };
  }, [documentId, key]);

  return {
    provider,
  };
}
