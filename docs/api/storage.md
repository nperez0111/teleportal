# Storage API

Complete API reference for Teleportal storage interfaces.

## DocumentStorage

Interface for storing document content and metadata.

### Methods

#### `handleUpdate(documentId, update)`

Handles a document update.

```typescript
handleUpdate(documentId: string, update: Update): Promise<void>
```

#### `getDocument(documentId)`

Gets a document by ID.

```typescript
getDocument(documentId: string): Promise<Document | null>
```

#### `writeDocumentMetadata(documentId, metadata)`

Writes document metadata.

```typescript
writeDocumentMetadata(
  documentId: string,
  metadata: DocumentMetadata
): Promise<void>
```

#### `getDocumentMetadata(documentId)`

Gets document metadata.

```typescript
getDocumentMetadata(documentId: string): Promise<DocumentMetadata>
```

#### `deleteDocument(documentId)`

Deletes a document.

```typescript
deleteDocument(documentId: string): Promise<void>
```

#### `transaction(documentId, callback)`

Executes operations in a transaction.

```typescript
transaction<T>(
  documentId: string,
  callback: () => Promise<T>
): Promise<T>
```

## FileStorage

Interface for storing file data.

### Methods

#### `getFile(fileId)`

Gets a file by ID.

```typescript
getFile(fileId: string): Promise<File | null>
```

#### `deleteFile(fileId)`

Deletes a file.

```typescript
deleteFile(fileId: string): Promise<void>
```

#### `listFileMetadataByDocument(documentId)`

Lists file metadata for a document.

```typescript
listFileMetadataByDocument(documentId: string): Promise<FileMetadata[]>
```

#### `deleteFilesByDocument(documentId)`

Deletes all files for a document.

```typescript
deleteFilesByDocument(documentId: string): Promise<void>
```

#### `storeFileFromUpload(uploadResult)`

Stores a file from an upload result.

```typescript
storeFileFromUpload(uploadResult: FileUploadResult): Promise<void>
```

## MilestoneStorage

Interface for storing document milestones.

### Methods

#### `createMilestone(documentId, snapshot, name?)`

Creates a milestone.

```typescript
createMilestone(
  documentId: string,
  snapshot: Uint8Array,
  name?: string
): Promise<Milestone>
```

#### `getMilestone(milestoneId)`

Gets a milestone by ID.

```typescript
getMilestone(milestoneId: string): Promise<Milestone | null>
```

#### `listMilestones(documentId, snapshotIds?)`

Lists milestones for a document.

```typescript
listMilestones(
  documentId: string,
  snapshotIds?: string[]
): Promise<Milestone[]>
```

#### `updateMilestoneName(milestoneId, name)`

Updates a milestone name.

```typescript
updateMilestoneName(milestoneId: string, name: string): Promise<Milestone>
```

## Factory Functions

### `createInMemory(options?)`

Creates in-memory storage.

```typescript
createInMemory(options?: {
  encrypted?: boolean;
  useYDoc?: boolean;
}): { documentStorage: DocumentStorage; fileStorage: FileStorage }
```

### `createUnstorage(storage, options?)`

Creates unstorage-based storage.

```typescript
createUnstorage(storage: Storage, options?: {
  fileKeyPrefix?: string;
  documentKeyPrefix?: string;
  encrypted?: boolean;
  scanKeys?: boolean;
  ttl?: number;
}): { documentStorage: DocumentStorage; fileStorage: FileStorage }
```

## Examples

See the [Storage Guide](../../guide/storage.md) for complete examples.
