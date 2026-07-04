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

/**
 * Suffix for a per-tab `?user=` identity override (see identity.ts), so each
 * simulated user keeps an isolated document list — as if in its own browser.
 */
function userSuffix(): string {
  const user =
    typeof location !== "undefined" ? new URLSearchParams(location.search).get("user") : null;
  return user ? `:${user}` : "";
}

class FileService extends Observable<{
  documents: (documents: Document[]) => void;
}> {
  private get STORAGE_KEY() {
    return `teleportal-documents${userSuffix()}`;
  }
  private get CURRENT_DOC_KEY() {
    return `teleportal-current-document${userSuffix()}`;
  }
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
    const existing = documents.find((doc) => doc.id === options.id);
    if (existing) {
      if (existing.wrappingKey) {
        await this.ensureKeyAccess(existing.id);
      }
      return existing;
    }

    const documentId = options.id ?? this.generateId(options.encrypted ?? false);
    let wrappingKey = options.wrappingKey;

    // For encrypted docs without a pre-existing key, get one from the backend.
    // Try granting access first (the document key may already exist from another
    // user). If no key exists yet, mint a new one.
    if (options.encrypted && !options.encryptedKey && !options.wrappingKey) {
      const { getIdentity } = await import("../utils/identity");
      const identity = getIdentity();
      const headers = { "Content-Type": "application/json" };
      const body = { userId: identity.name, room: "docs" };

      const grantRes = await fetch(`/keys/${documentId}/grant`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (grantRes.ok) {
        wrappingKey = (await grantRes.json()).wrappingKey;
      } else {
        const mintRes = await fetch(`/keys/${documentId}/mint`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        wrappingKey = (await mintRes.json()).wrappingKey;
      }
    }

    const newDocument: Document = {
      id: documentId,
      name: options.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // When using registry-based key distribution (wrappingKey), the document
      // key lives on the server — no local CryptoKey needed.
      encryptedKey:
        options.encryptedKey ??
        (options.encrypted && !wrappingKey ? await createEncryptionKey() : undefined),
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

  private async ensureKeyAccess(documentId: string): Promise<void> {
    const { getIdentity } = await import("../utils/identity");
    const identity = getIdentity();
    const headers = { "Content-Type": "application/json" };
    const body = JSON.stringify({ userId: identity.name, room: "docs" });

    const grantRes = await fetch(`/keys/${documentId}/grant`, {
      method: "POST",
      headers,
      body,
    });

    if (!grantRes.ok) {
      await fetch(`/keys/${documentId}/mint`, {
        method: "POST",
        headers,
        body,
      });
    }
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

    const isEncrypted = Boolean(key || document.wrappingKey);

    return `${window.location.origin}?name=${encodeURIComponent(document.name)}&id=${encodeURIComponent(id)}${key ? `&token=${encodeURIComponent(key)}` : ""}${isEncrypted && !key ? "&encrypted=true" : ""}`;
  }

  async loadDocumentFromUrl(url: string): Promise<Document | null> {
    const urlParams = new URLSearchParams(url);
    const documentId = urlParams.get("id");
    const name = urlParams.get("name");
    const token = urlParams.get("token");
    const encryptedParam = urlParams.get("encrypted") === "true";
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
      encrypted: Boolean(key) || encryptedParam,
      encryptedKey: key,
    });

    return document;
  }
}

export const fileService = new FileService();
