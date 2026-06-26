import { uuidv4 } from "lib0/random";
import { Observable } from "teleportal";
import {
  createEncryptionKey,
  exportEncryptionKey,
  importEncryptionKey,
} from "teleportal/encryption-key";

export type Document = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  encryptedKey: CryptoKey | undefined;
  wrappingKey?: string;
};

class FileService extends Observable<{
  documents: (documents: Document[]) => void;
}> {
  private readonly STORAGE_KEY = "teleportal-documents";
  private readonly CURRENT_DOC_KEY = "teleportal-current-document";
  public documents: Document[] = [];

  constructor() {
    super();
  }

  private async getDocuments(): Promise<Document[]> {
    const stored = localStorage.getItem(this.STORAGE_KEY);
    const documents = stored
      ? await Promise.all(
          JSON.parse(stored).map(
            async (doc: Omit<Document, "encryptedKey"> & { encryptedKey: string }) => ({
              ...doc,
              encryptedKey: doc.encryptedKey
                ? await importEncryptionKey(doc.encryptedKey)
                : undefined,
              wrappingKey: doc.wrappingKey,
            }),
          ),
        )
      : [];
    return documents.filter((doc, i, arr) => arr.findIndex((d) => d.id === doc.id) === i);
  }

  private async saveDocuments(documents: Document[]): Promise<void> {
    this.documents = documents;
    await this.call("documents", this.documents);
    localStorage.setItem(
      this.STORAGE_KEY,
      JSON.stringify(
        await Promise.all(
          documents
            .filter((doc, i, arr) => arr.findIndex((d) => d.id === doc.id) === i)
            .map(async (doc) => ({
              ...doc,
              encryptedKey: doc.encryptedKey
                ? await exportEncryptionKey(doc.encryptedKey)
                : undefined,
              wrappingKey: doc.wrappingKey,
            })),
        ),
      ),
    );
  }

  async loadAllDocuments(): Promise<Document[]> {
    this.documents = await this.getDocuments();
    await this.call("documents", this.documents);
    return this.documents;
  }

  getDocument(id: string | null): Document | null {
    if (!id) return null;
    const documents = this.documents;
    return documents.find((doc) => doc.id === id) || null;
  }

  async createDocument(options: {
    id?: string;
    name: string;
    encrypted?: boolean;
    encryptedKey?: CryptoKey;
    wrappingKey?: string;
  }): Promise<Document> {
    const documents = await this.getDocuments();
    if (documents.find((doc) => doc.id === options.id)) {
      return documents.find((doc) => doc.id === options.id)!;
    }

    const documentId = options.id ?? this.generateId(options.encrypted ?? false);
    let wrappingKey = options.wrappingKey;

    // For encrypted docs without a pre-existing key, mint via the backend
    if (options.encrypted && !options.encryptedKey && !options.wrappingKey) {
      const { getIdentity } = await import("../utils/identity");
      const identity = getIdentity();
      const res = await fetch(`/keys/${documentId}/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: identity.name, room: "docs" }),
      });
      const data = await res.json();
      wrappingKey = data.wrappingKey;
    }

    const newDocument: Document = {
      id: documentId,
      name: options.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // When using registry-based key distribution (wrappingKey), the document
      // key lives on the server — no local CryptoKey needed.
      encryptedKey: options.encryptedKey ?? (options.encrypted && !wrappingKey ? await createEncryptionKey() : undefined),
      wrappingKey,
    };

    documents.push(newDocument);
    await this.saveDocuments(documents);
    return newDocument;
  }

  async updateDocument(id: string, updates: Partial<Document>): Promise<Document | null> {
    const index = this.documents.findIndex((doc) => doc.id === id);

    if (index === -1) return null;

    this.documents[index] = {
      ...this.documents[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    // async save the documents
    await this.saveDocuments(this.documents);
    return this.documents[index];
  }

  async deleteDocument(id: string): Promise<boolean> {
    const documents = this.documents;
    const filtered = documents.filter((doc) => doc.id !== id);

    if (filtered.length === documents.length) return false;

    // async save the documents
    await this.saveDocuments(filtered);
    return true;
  }

  // Save the current document ID to localStorage
  saveCurrentDocumentId(id: string | null): void {
    if (id) {
      localStorage.setItem(this.CURRENT_DOC_KEY, id);
    } else {
      localStorage.removeItem(this.CURRENT_DOC_KEY);
    }
  }

  // Get the current document ID from localStorage
  getCurrentDocumentId(): string | null {
    return localStorage.getItem(this.CURRENT_DOC_KEY);
  }

  private generateId(encrypted: boolean): string {
    return encrypted ? `encrypted-${uuidv4()}` : uuidv4();
  }

  async shareDocumentUrl(id: string): Promise<string> {
    const document = this.getDocument(id);
    if (!document) return "";

    const key = document.encryptedKey
      ? await exportEncryptionKey(document.encryptedKey)
      : undefined;

    return `${window.location.origin}?name=${encodeURIComponent(document.name)}&id=${encodeURIComponent(id)}${key ? `&token=${encodeURIComponent(key)}` : ""}`;
  }

  async loadDocumentFromUrl(url: string): Promise<Document | null> {
    const urlParams = new URLSearchParams(url);
    const documentId = urlParams.get("id");
    const name = urlParams.get("name");
    const token = urlParams.get("token");
    let key: CryptoKey | undefined;
    if (token) {
      key = await importEncryptionKey(token);
    }

    if (!documentId || !name) {
      return null;
    }

    const document = await this.createDocument({
      id: documentId,
      name,
      encrypted: Boolean(key),
      encryptedKey: key,
    });

    return document;
  }
}

export const fileService = new FileService();
