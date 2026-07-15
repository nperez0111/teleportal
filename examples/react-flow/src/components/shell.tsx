import * as random from "lib0/random";
import { useEffect, useState } from "react";

import { Provider } from "teleportal/providers";
import { createEncryptionKey } from "teleportal/encryption-key";
import { createTokenManager, DocumentAccessBuilder } from "teleportal/token";
import { FlowEditor } from "./flow-editor";

const usercolors = [
  { color: "#30bced", light: "#30bced33" },
  { color: "#6eeb83", light: "#6eeb8333" },
  { color: "#ffbc42", light: "#ffbc4233" },
  { color: "#ee6352", light: "#ee635233" },
  { color: "#9ac2c9", light: "#9ac2c933" },
  { color: "#8acb88", light: "#8acb8833" },
  { color: "#1be7ff", light: "#1be7ff33" },
];

const userColor = usercolors[random.uint32() % usercolors.length];

const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
  expiresIn: 3600,
  issuer: "react-flow-example",
});

export default function Shell() {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      try {
        const token = await tokenManager.createToken(
          "nick",
          "docs",
          new DocumentAccessBuilder().admin("*").build(),
        );

        const p = await Provider.create({
          url: `${new URL("./", window.location.href).href}?token=${token}`,
          document: "flow",
          encryptionKey: await createEncryptionKey(),
        });

        p.awareness.setLocalStateField("user", {
          name: "User " + Math.floor(Math.random() * 100),
          color: userColor.color,
        });

        setProvider(p);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to initialize");
      } finally {
        setIsLoading(false);
      }
    };

    init();
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen text-lg text-gray-600">
        Connecting to collaborative flow...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen text-lg text-red-600">
        Error: {error}
      </div>
    );
  }

  if (!provider) return null;

  return <FlowEditor provider={provider} />;
}
