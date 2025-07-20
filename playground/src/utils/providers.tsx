import { useEffect, useState } from "react";
import { websocket } from "teleportal/providers";
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
      url: `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/?token=${token}`,
    });
  });

export function useProvider(
  documentId: string | null | undefined,
  key: CryptoKey | undefined,
): {
  provider: websocket.Provider | null;
} {
  const [provider, setProvider] = useState<websocket.Provider | null>(null);

  useEffect(() => {
    if (!documentId) {
      return;
    }

    setProvider((p) => {
      if (p) {
        return p.switchDocument({
          document: documentId,
          getTransport: key
            ? getEncryptedTransport(key, documentId)
            : ({ getDefaultTransport }) => getDefaultTransport(),
        });
      }

      websocketConnection
        .then((client) => {
          // Create initial provider
          return websocket.Provider.create({
            client: client,
            document: documentId,
            getTransport: key
              ? getEncryptedTransport(key, documentId)
              : ({ getDefaultTransport }) => getDefaultTransport(),
          });
        })
        .then((newProvider) => {
          setProvider(newProvider);
        });
      return null;
    });

    return () => {
      provider?.destroy({ destroyWebSocket: false });
    };
  }, [documentId, key]);

  return {
    provider,
  };
}
