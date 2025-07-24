import { useState, useEffect } from "react";
import { Sidebar } from "./sidebar";
import { DocumentEditor } from "./documentEditor";
import { fileService } from "../services/fileService";

export function Shell() {
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(
    null,
  );
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

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

  // Close sidebar when clicking outside on mobile
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) {
        setIsSidebarOpen(false);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
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
    // Close sidebar on mobile after selecting a document
    if (window.innerWidth < 768) {
      setIsSidebarOpen(false);
    }
  };

  const toggleSidebar = () => {
    setIsSidebarOpen(!isSidebarOpen);
  };

  const closeSidebar = () => {
    setIsSidebarOpen(false);
  };

  return (
    <div className="flex h-screen bg-white dark:bg-gray-950 relative">
      {/* Overlay for mobile when sidebar is open */}
      {isSidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black bg-opacity-50 z-30"
          onClick={closeSidebar}
          aria-label="Close sidebar"
        />
      )}

      {/* Sidebar */}
      <div
        className={`
        ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}
        md:translate-x-0
        fixed md:relative
        z-40 md:z-auto
        transition-transform duration-300 ease-in-out
        h-full
      `}
      >
        <Sidebar
          currentDocumentId={currentDocumentId}
          onDocumentSelect={handleDocumentSelect}
          isMobile={window.innerWidth < 768}
          onClose={isSidebarOpen ? closeSidebar : undefined}
        />
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-hidden">
        <DocumentEditor
          documentId={currentDocumentId}
          isSidebarOpen={isSidebarOpen}
          toggleSidebar={toggleSidebar}
          closeSidebar={closeSidebar}
        />
      </div>
    </div>
  );
}
