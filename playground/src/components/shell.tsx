import { useState, useEffect } from "react";
import { Sidebar } from "./sidebar";
import { DocumentEditor } from "./documentEditor";
import { fileService } from "../services/fileService";

export function Shell() {
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    // Load documents and select the first one if available
    const documents = fileService.getAllDocuments();
    if (documents.length > 0 && !currentDocumentId) {
      setCurrentDocumentId(documents[0].id);
    }
  }, [currentDocumentId]);

  const handleDocumentSelect = (documentId: string) => {
    setCurrentDocumentId(documentId);
  };

  return (
    <div className="flex h-screen bg-white">
      <Sidebar
        currentDocumentId={currentDocumentId}
        onDocumentSelect={handleDocumentSelect}
      />
      <DocumentEditor documentId={currentDocumentId} />
    </div>
  );
}
