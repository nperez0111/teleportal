import { uuidv4 } from "lib0/random.js";

export interface Document {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  encrypted: boolean;
}

class FileService {
  private readonly STORAGE_KEY = "notion-documents";
  private readonly CURRENT_DOC_KEY = "notion-current-document";

  private getDocuments(): Document[] {
    const stored = localStorage.getItem(this.STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  }

  private saveDocuments(documents: Document[]): void {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(documents));
  }

  getAllDocuments(): Document[] {
    return this.getDocuments();
  }

  getDocument(id: string): Document | null {
    const documents = this.getDocuments();
    return documents.find((doc) => doc.id === id) || null;
  }

  createDocument(name: string, encrypted: boolean = false): Document {
    const documents = this.getDocuments();
    const newDocument: Document = {
      id: this.generateId(encrypted),
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      encrypted,
    };

    documents.push(newDocument);
    this.saveDocuments(documents);
    return newDocument;
  }

  updateDocument(id: string, updates: Partial<Document>): Document | null {
    const documents = this.getDocuments();
    const index = documents.findIndex((doc) => doc.id === id);

    if (index === -1) return null;

    documents[index] = {
      ...documents[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.saveDocuments(documents);
    return documents[index];
  }

  deleteDocument(id: string): boolean {
    const documents = this.getDocuments();
    const filtered = documents.filter((doc) => doc.id !== id);

    if (filtered.length === documents.length) return false;

    this.saveDocuments(filtered);
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
}

export const fileService = new FileService();
