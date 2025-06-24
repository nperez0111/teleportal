export interface Document {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  content?: string;
}

class FileService {
  private readonly STORAGE_KEY = "notion-documents";

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

  createDocument(name: string): Document {
    const documents = this.getDocuments();
    const newDocument: Document = {
      id: this.generateId(),
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

export const fileService = new FileService();
