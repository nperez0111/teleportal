import * as random from "lib0/random";
import { useEffect, useState } from "react";

import { FallbackConnection, Provider } from "teleportal/providers";
import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";
import { Whiteboard } from "./whiteboard";

export const usercolors = [
  { color: "#30bced", light: "#30bced33" },
  { color: "#6eeb83", light: "#6eeb8333" },
  { color: "#ffbc42", light: "#ffbc4233" },
  { color: "#ecd444", light: "#ecd44433" },
  { color: "#ee6352", light: "#ee635233" },
  { color: "#9ac2c9", light: "#9ac2c933" },
  { color: "#8acb88", light: "#8acb8833" },
  { color: "#1be7ff", light: "#1be7ff33" },
];

export const userColor = usercolors[random.uint32() % usercolors.length];

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

export default function Shell() {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initializeProvider = async () => {
      try {
        const token = await tokenManager.createToken(
          "nick",
          "docs",
          new DocumentAccessBuilder().admin("*").build(),
        );

        const connection = new FallbackConnection({
          url: `${window.location.protocol}//${window.location.host}/?token=${token}`,
        });

        const websocketProvider = await Provider.create({
          connection,
          document: "whiteboard",
        });

        websocketProvider.awareness.setLocalStateField("user", {
          name: "Anonymous " + Math.floor(Math.random() * 100),
          color: userColor.color,
          colorLight: userColor.light,
        });

        setProvider(websocketProvider);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to initialize provider",
        );
      } finally {
        setIsLoading(false);
      }
    };

    initializeProvider();
  }, []);

  if (isLoading) {
    return (
      <div
        style={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "18px",
        }}
      >
        Connecting to collaborative whiteboard...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          width: "100vw",
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "18px",
          color: "red",
        }}
      >
        Error: {error}
      </div>
    );
  }

  if (!provider) {
    return null;
  }

  return <Whiteboard provider={provider} />;
}
