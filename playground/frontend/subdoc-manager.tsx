import { useEffect, useState } from "react";
import * as Y from "yjs";
import { websocket } from "teleportal/providers";
import { SingleEditor } from "./editor-components";

interface SubdocViewerProps {
  provider: websocket.Provider;
}

export function SubdocViewer({ provider }: SubdocViewerProps) {
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
  }, [provider, docs.length]);

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

interface SubdocListProps {
  provider: websocket.Provider;
  subdocs: string[];
}

export function SubdocList({ provider, subdocs }: SubdocListProps) {
  if (subdocs.length === 0) return null;

  return (
    <div>
      <h4>Subdocs:</h4>
      {subdocs.map((subdoc) => (
        <div key={subdoc}>
          <h5>Name: {subdoc}</h5>
          <SingleEditor provider={provider.subdocs.get(subdoc)!} />
        </div>
      ))}
    </div>
  );
}
