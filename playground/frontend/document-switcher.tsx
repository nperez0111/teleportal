import { useState } from "react";

interface DocumentSwitcherProps {
  currentDocument: string;
  onSwitchDocument: (documentName: string) => void;
}

export function DocumentSwitcher({
  currentDocument,
  onSwitchDocument,
}: DocumentSwitcherProps) {
  const [newDocumentName, setNewDocumentName] = useState("");

  const handleSwitch = () => {
    if (newDocumentName.trim()) {
      onSwitchDocument(newDocumentName.trim());
      setNewDocumentName("");
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSwitch();
    }
  };

  return (
    <div
      style={{
        padding: "1rem",
        backgroundColor: "#f0f0f0",
        borderRadius: "8px",
        marginBottom: "1rem",
      }}
    >
      <div style={{ marginBottom: "0.5rem" }}>
        <strong>Current Document:</strong> {currentDocument}
      </div>

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
        }}
      >
        <input
          type="text"
          value={newDocumentName}
          onChange={(e) => setNewDocumentName(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="Enter new document name"
          style={{
            padding: "0.5rem",
            borderRadius: "4px",
            border: "1px solid #ddd",
            flex: 1,
          }}
        />
        <button
          onClick={handleSwitch}
          disabled={!newDocumentName.trim()}
          style={{
            padding: "0.5rem 1rem",
            backgroundColor: "#0070f3",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            opacity: newDocumentName.trim() ? 1 : 0.6,
          }}
        >
          Switch Document
        </button>
      </div>

      <div style={{ marginTop: "0.5rem" }}>
        <button
          onClick={() => onSwitchDocument("test-this")}
          style={{
            padding: "0.25rem 0.5rem",
            backgroundColor: "#28a745",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            marginRight: "0.5rem",
            fontSize: "0.875rem",
          }}
        >
          Switch to "test-this"
        </button>
        <button
          onClick={() => onSwitchDocument("Testy")}
          style={{
            padding: "0.25rem 0.5rem",
            backgroundColor: "#28a745",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "0.875rem",
          }}
        >
          Switch to "Testy"
        </button>
      </div>
    </div>
  );
}
