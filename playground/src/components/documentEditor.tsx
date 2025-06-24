import { useState, useEffect } from "react";
import { Editor } from "./editor";
import { Document, fileService } from "../services/fileService";

interface DocumentEditorProps {
  documentId: string | null;
}

export function DocumentEditor({ documentId }: DocumentEditorProps) {
  const [document, setDocument] = useState<Document | null>(null);

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
        <div className="text-center text-gray-500">
          <svg
            className="w-16 h-16 mx-auto mb-4 text-gray-300"
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
      <div className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">
              {document.name}
            </h1>
            <p className="text-sm text-gray-500">
              Created {new Date(document.createdAt).toLocaleDateString()} • Last
              updated {new Date(document.updatedAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex items-center space-x-2">
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded">
              Document ID: {document.id.slice(-8)}
            </span>
          </div>
        </div>
      </div>

      {/* Editor Area */}
      <div className="flex-1 overflow-hidden">
        <Editor />
      </div>
    </div>
  );
}
