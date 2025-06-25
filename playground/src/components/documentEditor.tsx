import { useState, useEffect, Suspense } from "react";
import { Editor } from "./editor";
import { Document, fileService } from "../services/fileService";
import { useProvider } from "../utils/providers";

interface DocumentEditorProps {
  documentId: string | null;
}

export function DocumentEditor({ documentId }: DocumentEditorProps) {
  const [document, setDocument] = useState<Document | null>(null);
  const { provider } = useProvider(document?.id, document?.encrypted);

  useEffect(() => {
    if (documentId) {
      const doc = fileService.getDocument(documentId);
      setDocument(doc);
    } else {
      setDocument(null);
    }
  }, [documentId]);

  if (!documentId || !document) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-gray-500 dark:text-gray-400">
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
      <div className="border-b h-20 border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
              {document.name}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Created {new Date(document.createdAt).toLocaleDateString()} • Last
              updated {new Date(document.updatedAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex items-center space-x-2">
            <span className="text-xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-900 px-2 py-1 rounded">
              Document ID: {document.id.slice(-8)}
            </span>
          </div>
        </div>
      </div>

      {/* Editor Area */}
      <div className="flex-1 max-w-5xl mx-auto w-full overflow-hidden px-2 py-4">
        {provider && (
          <Suspense fallback={<div>Loading...</div>}>
            <Editor provider={provider} key={provider.doc.clientID} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
