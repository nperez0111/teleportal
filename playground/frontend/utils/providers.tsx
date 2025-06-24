import { useState, useEffect } from "react";
import { websocket } from "teleportal/providers";
import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";
import { withEncryption } from "teleportal/transports";
import { useEncryptionKeyFromUrl } from "./encrypted";

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

export interface ProviderManager {
  provider: websocket.Provider | null;
  switchDocument: (documentName: string) => void;
  currentDocument: string;
}

export function useProviderManager(
  initialDocument: string = "test",
): ProviderManager {
  const { key } = useEncryptionKeyFromUrl();
  const [provider, setProvider] = useState<websocket.Provider | null>(null);
  const [currentDocument, setCurrentDocument] =
    useState<string>(initialDocument);

  useEffect(() => {
    if (!key) {
      return;
    }
    tokenManager
      .createToken(
        "nick",
        "docs",
        new DocumentAccessBuilder()
          .admin("*")
          // .write("Testy")
          // .readOnly("test-this")
          .build(),
      )
      .then((token) => {
        // Create initial provider
        return websocket.Provider.create({
          url: `ws://localhost:1234/?token=${token}`,
          document: initialDocument,
          // getTransport: ({ getDefaultTransport }) =>
          //   withEncryption(getDefaultTransport(), { key }),
        }).then((newProvider) => {
          setProvider(newProvider);
        });
      });
  }, [initialDocument, key]);

  const switchDocument = (documentName: string) => {
    if (provider) {
      const newProvider = provider.switchDocument(documentName);
      setProvider(newProvider);
      setCurrentDocument(documentName);
    }
  };

  return {
    provider,
    switchDocument,
    currentDocument,
  };
}
