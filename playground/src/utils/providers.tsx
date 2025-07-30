import { useEffect, useState } from "react";
import { websocket, Provider } from "teleportal/providers";
import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";

import { getEncryptedTransport } from "./encrypted";

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const websocketConnection = tokenManager
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

export function useProvider(
  documentId: string | null | undefined,
  key: CryptoKey | undefined,
): {
  provider: Provider | null;
} {
  const [provider, setProvider] = useState<Provider | null>(null);

  useEffect(() => {
    if (!documentId) {
      return;
    }

    setProvider((p) => {
      if (p) {
        return p.switchDocument({
          document: documentId,
          getTransport: key
            ? getEncryptedTransport(key)
            : ({ getDefaultTransport }) => getDefaultTransport(),
        });
      }

      websocketConnection
        .then((client) => {
          // Create initial provider
          return Provider.create({
            client,
            document: documentId,
            getTransport: key
              ? getEncryptedTransport(key)
              : ({ getDefaultTransport }) => getDefaultTransport(),
            enableOfflinePersistence: false,
          });
        })
        .then((newProvider) => {
          setProvider(newProvider);
        });
      return null;
    });

    return () => {
      provider?.destroy({ destroyConnection: false });
    };
  }, [documentId, key]);

  return {
    provider,
  };
}
