import { useState } from "react";
import { Document, fileService } from "../services/fileService";

interface SidebarProps {
  currentDocumentId: string | null;
  onDocumentSelect: (documentId: string) => void;
  isMobile?: boolean;
  onClose?: () => void;
}

export function Sidebar({ currentDocumentId, onDocumentSelect, isMobile = false, onClose }: SidebarProps) {
  const documents = fileService.documents;
  const [, forceUpdate] = useState<number>(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showCopiedTooltip, setShowCopiedTooltip] = useState<string | null>(
    null,
  );

  const createNewDocument = async (encrypted: boolean = false) => {
    const newDoc = await fileService.createDocument({
      name: "Untitled",
      encrypted,
    });
    forceUpdate((prev) => prev + 1);
    onDocumentSelect(newDoc.id);
  };

  const handleCreateRegularDocument = () => {
    createNewDocument(false);
  };

  const handleCreateEncryptedDocument = () => {
    createNewDocument(true);
  };

  const startEditing = (doc: Document) => {
    setEditingId(doc.id);
    setEditingName(doc.name);
  };

  const saveEdit = async () => {
    if (editingId && editingName.trim()) {
      await fileService.updateDocument(editingId, {
        name: editingName.trim(),
      });
      forceUpdate((prev) => prev + 1);
    }
    setEditingId(null);
    setEditingName("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName("");
  };

  const deleteDocument = async (id: string) => {
    await fileService.deleteDocument(id);
    forceUpdate((prev) => prev + 1);
    if (currentDocumentId === id) {
      // Clear the saved document ID since it was deleted
      fileService.saveCurrentDocumentId(null);
      const remainingDocs = fileService.documents;
      if (remainingDocs.length > 0) {
        onDocumentSelect(remainingDocs[0].id);
      }
    }
  };

  const handleShare = async (doc: Document) => {
    try {
      const url = await fileService.shareDocumentUrl(doc.id);
      await navigator.clipboard.writeText(url);
      setShowCopiedTooltip(doc.id);
      setTimeout(() => setShowCopiedTooltip(null), 2000);
    } catch (error) {
      console.error("Failed to copy URL:", error);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  // Filter documents based on search query
  const filteredDocuments = documents.filter((doc) =>
    doc.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className={`${isMobile ? 'w-80' : 'w-64'} bg-gray-50 dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 flex flex-col h-full max-w-[calc(100vw-2rem)] md:max-w-none`}>
      {/* Header */}
      <div className="px-4 h-20 flex items-center justify-between border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center space-x-3">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-white">
              TelePortal
            </h2>
            {isMobile && onClose && (
              <button
                onClick={onClose}
                className="p-1 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-900 rounded-lg transition-colors ml-auto"
                title="Close sidebar"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
          <div className="flex items-center space-x-1">
            <button
              onClick={handleCreateEncryptedDocument}
              className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-900 rounded-lg transition-colors"
              title="Create encrypted document"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            </button>
            <button
              onClick={handleCreateRegularDocument}
              className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-900 rounded-lg transition-colors"
              title="Create new document"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="p-3 border-b border-gray-200 dark:border-gray-800">
        <div className="relative">
          <input
            type="text"
            placeholder="Search documents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-3 py-2 pl-10 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
          />
          <svg
            className="absolute left-3 top-2.5 w-4 h-4 text-gray-400 dark:text-gray-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
      </div>

      {/* Document List */}
      <div className="flex-1 overflow-y-auto p-2">
        {documents.length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            <div className="mb-4">
              <svg
                className="w-12 h-12 mx-auto text-gray-300 dark:text-gray-700"
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
            </div>
            <p className="font-medium mb-2">Welcome to your workspace!</p>
            <p className="text-sm mb-4">
              Create your first document to get started
            </p>
            <button
              onClick={handleCreateRegularDocument}
              className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline"
            >
              Create your first document
            </button>
          </div>
        ) : filteredDocuments.length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            <div className="mb-4">
              <svg
                className="w-12 h-12 mx-auto text-gray-300 dark:text-gray-700"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
            <p className="font-medium mb-2">No documents found</p>
            <p className="text-sm">Try adjusting your search terms</p>
          </div>
        ) : (
          <div className="space-y-1">
            {filteredDocuments.map((doc) => (
              <div
                key={doc.id}
                className={`group relative p-3 rounded-lg cursor-pointer transition-colors ${
                  currentDocumentId === doc.id
                    ? "bg-blue-100 dark:bg-gray-900 ring-2 ring-blue-200 dark:ring-gray-700"
                    : "hover:bg-gray-100 dark:hover:bg-gray-900"
                }`}
                onClick={() => onDocumentSelect(doc.id)}
              >
                {editingId === doc.id ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEdit();
                        if (e.key === "Escape") cancelEdit();
                      }}
                      onBlur={saveEdit}
                      className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-700 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-900 dark:text-white"
                      autoFocus
                    />
                    <div className="flex space-x-1">
                      <button
                        onClick={saveEdit}
                        className="text-xs px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
                      >
                        Save
                      </button>
                      <button
                        onClick={cancelEdit}
                        className="text-xs px-2 py-1 bg-gray-500 text-white rounded hover:bg-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center space-x-1">
                          <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate">
                            {doc.name}
                          </h3>
                          {Boolean(doc.encryptedKey) && (
                            <svg
                              className="w-3 h-3 text-gray-500 dark:text-gray-400 flex-shrink-0"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                              />
                            </svg>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Updated {formatDate(doc.updatedAt)}
                        </p>
                      </div>
                      <div className={`${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity flex space-x-1`}>
                        <div className="relative">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleShare(doc);
                            }}
                            className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded touch-manipulation"
                            title="Share document"
                          >
                            <svg
                              className="w-3 h-3"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                              />
                            </svg>
                          </button>
                          {showCopiedTooltip === doc.id && (
                            <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs rounded-md shadow-lg z-10 whitespace-nowrap">
                              URL copied to clipboard!
                              <div className="absolute bottom-full right-1 w-0 h-0 border-l-4 border-r-4 border-b-4 border-transparent border-b-gray-900 dark:border-b-gray-100"></div>
                            </div>
                          )}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startEditing(doc);
                          }}
                          className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded touch-manipulation"
                          title="Edit name"
                        >
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                            />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteDocument(doc.id);
                          }}
                          className="p-1 text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 rounded touch-manipulation"
                          title="Delete document"
                        >
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
