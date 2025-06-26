import { useState, useEffect, Suspense } from "react";
import { Editor } from "./editor";
import { Document, fileService } from "../services/fileService";
import { useProvider } from "../utils/providers";

interface DocumentEditorProps {
  documentId: string | null;
}

export function DocumentEditor({ documentId }: DocumentEditorProps) {
  const document = fileService.getDocument(documentId);
  const [, forceUpdate] = useState<number>(0);
  const { provider } = useProvider(document?.id, document?.encryptedKey);

  useEffect(() => {
    const unsubscribe = fileService.on("documents", () => {
      forceUpdate((prev) => prev + 1);
    });
    return () => {
      fileService.off("documents", unsubscribe);
    };
  }, []);

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
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
                {document.name}
              </h1>
              {Boolean(document.encryptedKey) && (
                <svg
                  className="w-5 h-5 text-gray-500 dark:text-gray-400"
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
          <div className="flex items-center space-x-2"></div>
        </div>
      </div>

      {/* Editor Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="h-full max-w-5xl mx-auto w-full px-8 py-4">
          {provider && (
            <Suspense fallback={<div>Loading...</div>}>
              <Editor provider={provider} key={provider.doc.clientID} />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
