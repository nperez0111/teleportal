import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useCreateBlockNote } from "@blocknote/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Awareness } from "y-protocols/awareness.js";
import * as Y from "yjs";
import {
  createEncryptionKey,
  exportEncryptionKey,
  importEncryptionKey,
} from "match-maker/encryption-key";
import { websocket } from "match-maker/providers";
import { withEncryption } from "match-maker/transports";

function SingleEditor({ provider }: { provider: websocket.Provider }) {
  // Creates a new editor instance.
  const editor = useCreateBlockNote({
    collaboration: {
      fragment: provider.doc.getXmlFragment("document"),
      user: {
        name: "NICK THE SICK",
        color: "#" + Math.floor(Math.random() * 16777215).toString(16),
      },
      provider,
    },
  });

  // Renders the editor instance using a React component.
  return <BlockNoteView editor={editor} />;
}

export function Editor() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <EditorLoader />
    </Suspense>
  );
}

// This is a nice pattern
const EditorLoader = lazy(async () => {
  // Provider.create({
  //   url: "ws://localhost:1234/_ws",
  //   document: "testy",
  // }).then((provider) => {
  //   return { default: () => <Page provider={provider} /> };
  // }),
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);

  // Get or create encryption key
  let key: CryptoKey;
  const storedKey = localStorage.getItem("key");
  if (storedKey) {
    key = await importEncryptionKey(storedKey);
  } else {
    key = await createEncryptionKey();
    const exportedKey = await exportEncryptionKey(key);
    localStorage.setItem("key", exportedKey);
  }

  return websocket.Provider.create({
    url: "ws://localhost:1234/_ws",
    document: "encrypted-1175045416878",
    // document: "encrypted-1" + Date.now(),
    ydoc,
    awareness,
    getTransport: ({ getDefaultTransport }) =>
      withEncryption(getDefaultTransport(), { key }),
  }).then((provider) => {
    return { default: () => <Page provider={provider} encryptionKey={key} /> };
  });
});

function Page({
  provider: initialProvider,
  encryptionKey: initialKey,
}: {
  provider: websocket.Provider;
  encryptionKey: CryptoKey;
}) {
  const [provider, setProvider] = useState(initialProvider);
  const [key, setKey] = useState<CryptoKey>(initialKey);
  const [keyString, setKeyString] = useState<string>("");
  const [subdocs, setSubdocs] = useState<string[]>(() =>
    Array.from(provider.subdocs.keys()),
  );

  useEffect(() => {
    const handler = provider.on("load-subdoc", (subdoc) => {
      setSubdocs(Array.from(provider.subdocs.keys()));
    });
    return () => {
      provider.off("load-subdoc", handler);
    };
  }, [provider]);

  useEffect(() => {
    // Export the current key to string for display
    exportEncryptionKey(key).then(setKeyString);
  }, [key]);

  const handleKeyChange = async (newKeyString: string) => {
    try {
      const newKey = await importEncryptionKey(newKeyString);
      setKey(newKey);
      localStorage.setItem("key", newKeyString);
    } catch (error) {
      console.error("Failed to import key:", error);
    }
  };

  // Renders the editor instance using a React component.
  return (
    <div>
      <button onClick={() => setProvider(provider.switchDocument("test-this"))}>
        Switch Document
      </button>
      Document: {provider.document}
      <input
        type="text"
        value={keyString}
        onChange={(e) => handleKeyChange(e.target.value)}
        placeholder="Enter encryption key"
      />
      <SingleEditor key={provider.document + "-editor"} provider={provider} />
      {/* <SubdocViewer key={provider.document + "-subdocs"} provider={provider} /> */}
      {/* {subdocs.length > 0 && (
        <div key={provider.document + "-subdoc-viewer"}>
          Subdocs:
          {subdocs.map((subdoc) => (
            <div key={subdoc}>
              Name: {subdoc}
              <SingleEditor provider={provider.subdocs.get(subdoc)!} />
            </div>
          ))}
        </div>
      )} */}
    </div>
  );
}
function SubdocViewer({ provider }: { provider: websocket.Provider }) {
  const [docs, setDocs] = useState(Array.from(provider.doc.getSubdocs()));
  const [newSubdocName, setNewSubdocName] = useState("");

  useEffect(() => {
    if (provider.doc.getMap().size !== docs.length) {
      setDocs(Array.from(provider.doc.getSubdocs()));
    }
    const handler = provider.on("update-subdocs", () => {
      setDocs(Array.from(provider.doc.getSubdocs()));
    });
    return () => {
      provider.off("update-subdocs", handler);
    };
  }, [provider]);

  const handleAddSubdoc = () => {
    if (!newSubdocName) return;
    const doc = new Y.Doc();
    provider.doc.getMap().set(newSubdocName, doc);
    setNewSubdocName("");
  };

  const handleLoadSubdoc = (parentSub: string) => {
    provider.doc.getMap<Y.Doc>().get(parentSub)?.load();
  };

  return (
    <div
      style={{
        padding: "1rem",
        backgroundColor: "#f5f5f5",
        borderRadius: "8px",
      }}
    >
      <div
        style={{
          marginBottom: "1.5rem",
          display: "flex",
          gap: "0.5rem",
        }}
      >
        <input
          type="text"
          value={newSubdocName}
          onChange={(e) => setNewSubdocName(e.target.value)}
          placeholder="Enter subdoc name"
          style={{
            padding: "0.5rem",
            borderRadius: "4px",
            border: "1px solid #ddd",
            flex: 1,
          }}
        />
        <button
          onClick={handleAddSubdoc}
          style={{
            padding: "0.5rem 1rem",
            backgroundColor: "#0070f3",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Add Subdoc
        </button>
      </div>

      <div>
        <h3 style={{ marginBottom: "1rem", color: "#333" }}>
          Existing Subdocs:
        </h3>
        {docs.length === 0 ? (
          <p style={{ color: "#666", fontStyle: "italic" }}>No subdocs yet</p>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
            }}
          >
            {docs.map((doc) => {
              const parentSub = doc._item?.parentSub;
              return (
                <li
                  key={parentSub}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "0.75rem",
                    backgroundColor: "white",
                    borderRadius: "4px",
                    marginBottom: "0.5rem",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                  }}
                  onClick={() => handleLoadSubdoc(parentSub!)}
                >
                  <span style={{ fontWeight: 500 }}>{parentSub}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
