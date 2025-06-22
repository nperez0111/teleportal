import { useState, useEffect } from "react";

interface DocumentSwitcherProps {
  currentDocument: string;
  onSwitchDocument: (documentName: string) => void;
}

const DOCUMENTS_STORAGE_KEY = "match-maker-documents";

export function DocumentSwitcher({
  currentDocument,
  onSwitchDocument,
}: DocumentSwitcherProps) {
  const [newDocumentName, setNewDocumentName] = useState("");
  const [documents, setDocuments] = useState<string[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load documents from localStorage on component mount
  useEffect(() => {
    const savedDocuments = localStorage.getItem(DOCUMENTS_STORAGE_KEY);
    console.log("Loading documents from localStorage:", savedDocuments);
    if (savedDocuments) {
      try {
        const parsed = JSON.parse(savedDocuments);
        if (Array.isArray(parsed)) {
          setDocuments(parsed);
          console.log("Loaded documents:", parsed);
        }
      } catch (error) {
        console.error("Failed to parse saved documents:", error);
      }
    }
    setIsLoaded(true);
  }, []);

  // Save documents to localStorage whenever the list changes
  useEffect(() => {
    if (isLoaded) {
      console.log("Saving documents to localStorage:", documents);
      localStorage.setItem(DOCUMENTS_STORAGE_KEY, JSON.stringify(documents));
    }
  }, [documents, isLoaded]);

  // Add current document to the list if it's not already there
  useEffect(() => {
    if (isLoaded && currentDocument && !documents.includes(currentDocument)) {
      console.log("Adding current document to list:", currentDocument);
      setDocuments((prev) => [...prev, currentDocument]);
    }
  }, [currentDocument, isLoaded]); // Only depend on currentDocument and isLoaded

  const handleSwitch = () => {
    if (newDocumentName.trim()) {
      const documentName = newDocumentName.trim();
      onSwitchDocument(documentName);
      setNewDocumentName("");

      // Add to documents list if not already present
      if (!documents.includes(documentName)) {
        setDocuments((prev) => [...prev, documentName]);
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSwitch();
    }
  };

  const handleRemoveDocument = (documentName: string) => {
    setDocuments((prev) => prev.filter((doc) => doc !== documentName));
  };

  return (
    <div
      style={{
        padding: "1.5rem",
        backgroundColor: "#ffffff",
        borderRadius: "12px",
        marginBottom: "1.5rem",
        border: "1px solid #e5e7eb",
        boxShadow:
          "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)",
      }}
    >
      <div style={{ marginBottom: "1rem" }}>
        <div
          style={{
            fontSize: "0.875rem",
            color: "#6b7280",
            marginBottom: "0.25rem",
            fontWeight: "500",
          }}
        >
          Current Document
        </div>
        <div
          style={{
            fontSize: "1.125rem",
            fontWeight: "600",
            color: "#111827",
          }}
        >
          {currentDocument}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          alignItems: "center",
          marginBottom: "1.5rem",
        }}
      >
        <input
          type="text"
          value={newDocumentName}
          onChange={(e) => setNewDocumentName(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="Enter new document name"
          style={{
            padding: "0.75rem",
            borderRadius: "8px",
            border: "1px solid #d1d5db",
            flex: 1,
            fontSize: "0.875rem",
            outline: "none",
            transition:
              "border-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out",
            backgroundColor: "#f9fafb",
          }}
          onFocus={(e) => {
            e.target.style.borderColor = "#3b82f6";
            e.target.style.boxShadow = "0 0 0 3px rgba(59, 130, 246, 0.1)";
            e.target.style.backgroundColor = "#ffffff";
          }}
          onBlur={(e) => {
            e.target.style.borderColor = "#d1d5db";
            e.target.style.boxShadow = "none";
            e.target.style.backgroundColor = "#f9fafb";
          }}
        />
        <button
          onClick={handleSwitch}
          disabled={!newDocumentName.trim()}
          style={{
            padding: "0.75rem 1.25rem",
            backgroundColor: newDocumentName.trim() ? "#3b82f6" : "#e5e7eb",
            color: newDocumentName.trim() ? "#ffffff" : "#9ca3af",
            border: "none",
            borderRadius: "8px",
            cursor: newDocumentName.trim() ? "pointer" : "not-allowed",
            fontSize: "0.875rem",
            fontWeight: "500",
            transition: "all 0.15s ease-in-out",
            whiteSpace: "nowrap",
          }}
          onMouseEnter={(e) => {
            if (newDocumentName.trim()) {
              e.currentTarget.style.backgroundColor = "#2563eb";
            }
          }}
          onMouseLeave={(e) => {
            if (newDocumentName.trim()) {
              e.currentTarget.style.backgroundColor = "#3b82f6";
            }
          }}
        >
          Switch Document
        </button>
      </div>

      {documents.length > 0 && (
        <div>
          <div
            style={{
              marginBottom: "0.75rem",
              fontSize: "0.875rem",
              fontWeight: "600",
              color: "#374151",
            }}
          >
            Saved Documents ({documents.length})
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.5rem",
            }}
          >
            {documents.map((docName) => (
              <div
                key={docName}
                style={{
                  position: "relative",
                  display: "inline-block",
                }}
              >
                <button
                  onClick={() => onSwitchDocument(docName)}
                  style={{
                    padding: "0.5rem 0.75rem",
                    paddingRight: "2rem",
                    backgroundColor:
                      docName === currentDocument ? "#3b82f6" : "#f3f4f6",
                    color: docName === currentDocument ? "#ffffff" : "#374151",
                    border:
                      docName === currentDocument
                        ? "none"
                        : "1px solid #e5e7eb",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                    fontWeight: "500",
                    transition: "all 0.15s ease-in-out",
                    position: "relative",
                  }}
                  onMouseEnter={(e) => {
                    if (docName !== currentDocument) {
                      e.currentTarget.style.backgroundColor = "#e5e7eb";
                      e.currentTarget.style.borderColor = "#d1d5db";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (docName !== currentDocument) {
                      e.currentTarget.style.backgroundColor = "#f3f4f6";
                      e.currentTarget.style.borderColor = "#e5e7eb";
                    }
                  }}
                >
                  {docName}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveDocument(docName);
                    }}
                    style={{
                      position: "absolute",
                      right: "0.25rem",
                      top: "50%",
                      transform: "translateY(-50%)",
                      padding: "0.125rem",
                      backgroundColor: "transparent",
                      color:
                        docName === currentDocument
                          ? "rgba(255, 255, 255, 0.7)"
                          : "#9ca3af",
                      border: "none",
                      borderRadius: "3px",
                      cursor: "pointer",
                      fontSize: "0.75rem",
                      lineHeight: "1",
                      width: "20px",
                      height: "20px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "all 0.15s ease-in-out",
                    }}
                    title="Remove from list"
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor =
                        docName === currentDocument
                          ? "rgba(255, 255, 255, 0.2)"
                          : "#fef2f2";
                      e.currentTarget.style.color =
                        docName === currentDocument ? "#ffffff" : "#ef4444";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color =
                        docName === currentDocument
                          ? "rgba(255, 255, 255, 0.7)"
                          : "#9ca3af";
                    }}
                  >
                    ×
                  </button>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
