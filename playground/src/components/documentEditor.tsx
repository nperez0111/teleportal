import { useState, useEffect, Suspense } from "react";
import { Editor } from "./editor";
import { Document, fileService } from "../services/fileService";
import { useProvider } from "../utils/providers";
import { MilestonePanel } from "./milestonePanel";
import { Milestone } from "teleportal";

interface DocumentEditorProps {
  documentId: string | null;
  isSidebarOpen?: boolean;
  toggleSidebar?: () => void;
  closeSidebar?: () => void;
}

export function DocumentEditor({
  documentId,
  isSidebarOpen,
  toggleSidebar,
}: DocumentEditorProps) {
  const document = fileService.getDocument(documentId);
  const [, forceUpdate] = useState<number>(0);
  const { provider } = useProvider(document?.id, document?.encryptedKey);
  const [isMilestonePanelOpen, setIsMilestonePanelOpen] = useState(false);
  const [selectedMilestone, setSelectedMilestone] = useState<Milestone | null>(
    null,
  );

  useEffect(() => {
    const unsubscribe = fileService.on("documents", () => {
      forceUpdate((prev) => prev + 1);
    });
    return () => {
      fileService.off("documents", unsubscribe);
    };
  }, []);

  // Reset milestone state when document changes
  useEffect(() => {
    setSelectedMilestone(null);
    setIsMilestonePanelOpen(false);
  }, [documentId]);

  if (!documentId || !document) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center text-gray-500 dark:text-gray-400 max-w-sm">
          <svg
            className="w-16 h-16 mx-auto mb-4 text-gray-300 dark:text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <h3 className="text-lg font-medium mb-2">No document selected</h3>
          <p className="text-sm">
            Select a document from the sidebar to start editing
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Document Header */}
      <div className="border-b h-auto min-h-[60px] md:h-20 border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-4 md:px-6 py-3 md:py-4">
        <div className="flex items-start md:items-center justify-between flex-col md:flex-row gap-2 md:gap-0">
          <div className="min-w-0 flex-1 flex items-center gap-2">
            {/* Hamburger button for mobile */}
            <button
              onClick={toggleSidebar}
              className="md:hidden mr-2 p-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              aria-label="Toggle sidebar"
              type="button"
            >
              <svg
                className="w-6 h-6 text-gray-600 dark:text-gray-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {isSidebarOpen ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                )}
              </svg>
            </button>
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-lg md:text-xl font-semibold text-gray-900 dark:text-white truncate">
                {document.name}
              </h1>
              {Boolean(document.encryptedKey) && (
                <svg
                  className="w-4 h-4 md:w-5 md:h-5 text-gray-500 dark:text-gray-400 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8V7a4 4 0 00-8 0v4"
                  />
                </svg>
              )}
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Created {new Date(document.createdAt).toLocaleDateString()} • Last
              updated {new Date(document.updatedAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex items-center space-x-2 shrink-0">
            <button
              onClick={() => setIsMilestonePanelOpen(true)}
              className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors flex items-center gap-2"
              title="View document versions"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <span className="hidden md:inline">Versions</span>
            </button>
          </div>
        </div>
      </div>

      {/* Editor Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="h-full max-w-5xl mx-auto w-full px-4 md:px-6 lg:px-8 py-4 md:py-6">
          {provider && (
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-32">
                  <div className="text-gray-500 dark:text-gray-400">
                    Loading editor...
                  </div>
                </div>
              }
            >
              <Editor
                selectedMilestone={selectedMilestone}
                provider={provider}
                key={provider.doc.clientID}
              />
            </Suspense>
          )}
        </div>
      </div>

      {/* Milestone Panel */}
      <MilestonePanel
        onChangeSelectedMilestone={setSelectedMilestone}
        provider={provider}
        isOpen={isMilestonePanelOpen}
        onClose={() => setIsMilestonePanelOpen(false)}
      />
    </div>
  );
}
