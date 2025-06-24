import { useState, useEffect } from "react";
import { Document, fileService } from "../services/fileService";

interface SidebarProps {
  currentDocumentId: string | null;
  onDocumentSelect: (documentId: string) => void;
}

export function Sidebar({ currentDocumentId, onDocumentSelect }: SidebarProps) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  useEffect(() => {
    loadDocuments();
    // Create demo documents if none exist
    if (fileService.getAllDocuments().length === 0) {
      createDemoDocuments();
    }
  }, []);

  const loadDocuments = () => {
    setDocuments(fileService.getAllDocuments());
  };

  const createDemoDocuments = () => {
    const demoDocs = [
      "Welcome to Your Workspace",
      "Getting Started Guide",
      "Project Ideas",
      "Meeting Notes",
    ];

    demoDocs.forEach((name) => {
      fileService.createDocument(name);
    });

    loadDocuments();
  };

  const createNewDocument = () => {
    const newDoc = fileService.createDocument("Untitled");
    setDocuments(fileService.getAllDocuments());
    onDocumentSelect(newDoc.id);
  };

  const startEditing = (doc: Document) => {
    setEditingId(doc.id);
    setEditingName(doc.name);
  };

  const saveEdit = () => {
    if (editingId && editingName.trim()) {
      fileService.updateDocument(editingId, { name: editingName.trim() });
      setDocuments(fileService.getAllDocuments());
    }
    setEditingId(null);
    setEditingName("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName("");
  };

  const deleteDocument = (id: string) => {
    if (confirm("Are you sure you want to delete this document?")) {
      fileService.deleteDocument(id);
      setDocuments(fileService.getAllDocuments());
      if (currentDocumentId === id) {
        const remainingDocs = fileService.getAllDocuments();
        if (remainingDocs.length > 0) {
          onDocumentSelect(remainingDocs[0].id);
        }
      }
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  return (
    <div className="w-64 bg-gray-50 border-r border-gray-200 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">Documents</h2>
          <button
            onClick={createNewDocument}
            className="p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors"
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

      {/* Document List */}
      <div className="flex-1 overflow-y-auto p-2">
        {documents.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <div className="mb-4">
              <svg
                className="w-12 h-12 mx-auto text-gray-300"
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
              onClick={createNewDocument}
              className="text-blue-600 hover:text-blue-800 underline"
            >
              Create your first document
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className={`group relative p-3 rounded-lg cursor-pointer transition-colors ${
                  currentDocumentId === doc.id
                    ? "bg-blue-100 border border-blue-200"
                    : "hover:bg-gray-100"
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
                      className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                        <h3 className="text-sm font-medium text-gray-900 truncate">
                          {doc.name}
                        </h3>
                        <p className="text-xs text-gray-500">
                          Updated {formatDate(doc.updatedAt)}
                        </p>
                      </div>
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex space-x-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startEditing(doc);
                          }}
                          className="p-1 text-gray-400 hover:text-gray-600 rounded"
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
                          className="p-1 text-gray-400 hover:text-red-600 rounded"
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
