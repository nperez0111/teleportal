import { useEffect, useState } from "react";
import {
  websocket,
  Provider,
  DefaultTransportProperties,
} from "teleportal/providers";
import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";
import { getFileClientHandlers } from "teleportal/protocols/file";

import { getEncryptedTransport } from "./encrypted";
import { ClientContext, Transport } from "teleportal";
import { EncryptionClient } from "../../../src/transports/encrypted/client";

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

// Singleton provider manager to ensure only one provider instance exists (workaround for strict mode)
class ProviderManager {
  private static instance: ProviderManager | null = null;
  private provider: Provider<
    Transport<
      ClientContext,
      DefaultTransportProperties & { handler?: EncryptionClient }
    >
  > | null = null;
  private websocketConnection: Promise<websocket.WebSocketConnection> | null =
    null;
  private subscribers = new Set<(provider: Provider | null) => void>();

  private constructor() {}

  static getInstance(): ProviderManager {
    if (!ProviderManager.instance) {
      ProviderManager.instance = new ProviderManager();
    }
    return ProviderManager.instance;
  }

  private async getWebSocketConnection(): Promise<websocket.WebSocketConnection> {
    if (!this.websocketConnection) {
      this.websocketConnection = tokenManager
        .createToken(
          "nick",
          "docs",
          // TODO probably make token gen configurable callback
          new DocumentAccessBuilder()
            .admin("*")
            // .write("Testy")
            // .readOnly("test-this")
            .build(),
        )
        .then((token) => {
          return new websocket.WebSocketConnection({
            url: `${window.location.protocol}//${window.location.host}/?token=${token}`,
          });
        });
    }
    return this.websocketConnection;
  }

  async getProvider(
    documentId: string,
    key: CryptoKey | undefined,
  ): Promise<NonNullable<ProviderManager["provider"]>> {
    if (!this.provider) {
      const client = await this.getWebSocketConnection();
      this.provider = (await Provider.create({
        client,
        document: documentId,
        encryptionKey: key,
        rpcHandlers: {
          ...getFileClientHandlers({ encryptionKey: key }),
        },
        getTransport: ({ document, ydoc, awareness, getDefaultTransport }) => {
          const baseTransport = key
            ? getEncryptedTransport(key)({ document, ydoc, awareness })
            : getDefaultTransport();
          return baseTransport as any;
        },
        enableOfflinePersistence: false,
      })) as any;
    } else {
      // Switch document on existing provider
      this.provider = this.provider.switchDocument({
        document: documentId,
        encryptionKey: key,
        rpcHandlers: {
          ...getFileClientHandlers({ encryptionKey: key }),
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
    return this.provider as any;
  }

  subscribe(callback: (provider: Provider | null) => void): () => void {
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
  provider: Provider<
    Transport<
      ClientContext,
      DefaultTransportProperties & { handler?: EncryptionClient }
    >
  > | null;
} {
  const [provider, setProvider] = useState<Provider | null>(null);
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
    provider: provider as Provider<
      Transport<
        ClientContext,
        DefaultTransportProperties & { handler?: EncryptionClient }
      >
    > | null,
  };
}
