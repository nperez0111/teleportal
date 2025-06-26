import { useState, useEffect } from "react";
import { Sidebar } from "./sidebar";
import { DocumentEditor } from "./documentEditor";
import { fileService } from "../services/fileService";

export function Shell() {
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    async function load() {
      // Load documents and restore the last viewed document
      const documents = await fileService.loadAllDocuments();

      const doc = await fileService.loadDocumentFromUrl(window.location.search);
      if (doc) {
        setCurrentDocumentId(doc.id);
        return;
      }
      if (fileService.documents.length === 0) {
        // Create demo documents if none exist
        createDemoDocuments();
      }

      // Try to restore the last viewed document
      const savedDocumentId = fileService.getCurrentDocumentId();
      if (savedDocumentId && fileService.getDocument(savedDocumentId)) {
        setCurrentDocumentId(savedDocumentId);
      } else if (documents.length > 0) {
        // Fall back to the first document if the saved one doesn't exist
        setCurrentDocumentId(documents[0].id);
      }
    }
    load();
  }, []);

  const createDemoDocuments = async () => {
    const demoDocs = [
      "Welcome to Your Workspace",
      "Getting Started Guide",
      "Project Ideas",
      "Meeting Notes",
    ];

    const documents = await Promise.all(
      demoDocs.map((name) =>
        fileService.createDocument({
          name,
          encrypted: false,
        }),
      ),
    );
    setCurrentDocumentId(documents[0].id);
  };

  const handleDocumentSelect = (documentId: string) => {
    setCurrentDocumentId(documentId);
    // Save the selected document ID for persistence
    fileService.saveCurrentDocumentId(documentId);
  };

  return (
    <div className="flex h-screen bg-white dark:bg-gray-950">
      <Sidebar
        currentDocumentId={currentDocumentId}
        onDocumentSelect={handleDocumentSelect}
      />
      <DocumentEditor documentId={currentDocumentId} />
    </div>
  );
}
