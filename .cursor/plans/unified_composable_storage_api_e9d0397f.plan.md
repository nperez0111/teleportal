---
name: Unified Composable Storage API
overview: Merge the three separate storage interfaces (DocumentStorage, FileStorage, MilestoneStorage) into a single unified API based on the prototype in types.ts. The new API will be interface-based and composable, allowing different storage backends (e.g., S3 for milestones, Redis for documents) to be combined.
todos:
  - id: verify-types
    content: Verify src/storage/types.ts is complete and is the source of truth for all interfaces
    status: pending
  - id: create-temporary-upload-storage
    content: Create TemporaryUploadStorage implementations (unstorage and in-memory)
    status: pending
  - id: update-document-storage-impls
    content: Update all DocumentStorage implementations to use new interface from types.ts
    status: pending
  - id: update-file-storage-impls
    content: Update all FileStorage implementations to use new interface from types.ts
    status: pending
  - id: update-milestone-storage-impls
    content: Update all MilestoneStorage implementations to use new interface from types.ts
    status: pending
  - id: update-server-integration
    content: Update server.ts, session.ts, and file-handler.ts to use new storage API
    status: pending
  - id: update-tests
    content: Update all storage and server tests to use new interfaces
    status: pending
  - id: update-examples
    content: Update playground and example code to use new composable storage API
    status: pending
  - id: cleanup-old-files
    content: Delete old document-storage.ts, file-storage.ts, milestone-storage.ts files and update exports
    status: pending
---

# Unified Composable Storage API Migration

## Overview

Merge `src/storage/document-storage.ts`, `src/storage/file-storage.ts`, and `src/storage/milestone-storage.ts` into a unified, composable storage API. **`src/storage/types.ts` is the source of truth** for all interface definitions. All implementations must import and implement the interfaces from `types.ts`. The new API uses interfaces instead of abstract classes, enabling composition of different storage backends.

## Architecture

The new architecture separates concerns into:

- **DocumentStorage**: Core document operations (sync, updates, metadata)
- **FileStorage**: Long-term file storage (cold storage)
- **TemporaryUploadStorage**: Temporary upload session management
- **MilestoneStorage**: Milestone snapshots (can use cold storage like S3)

These can be composed together, allowing different backends for different concerns (e.g., milestones in S3, documents in Redis, files in local storage).

## Key Changes

**Note**: All interface definitions are in `src/storage/types.ts`. This file is the **source of truth**. All implementations must import interfaces from `types.ts` and implement them exactly as defined.

### Interface Changes

1. **DocumentStorage** (defined in `types.ts`):

- `key: string` → `documentId: Document["id"]` (more type-safe)
- `fetch()` → `getDocument()` (returns `Document` instead of `{ update, stateVector }`)
- `write()` → `handleUpdate()` (clearer naming)
- Added `handleSyncStep1()` returns `Document` instead of `{ update, stateVector }`
- Added `storageType: "encrypted" | "unencrypted"` property
- Optional `fileStorage` and `milestoneStorage` properties for composition

2. **FileStorage** (defined in `types.ts`):

- Separated from `UploadStorage` (now `TemporaryUploadStorage`)
- `getFile(contentId: Uint8Array)` → `getFile(fileId: File["id"])` (uses string ID)
- `getFilesByDocument()` → `listFileMetadataByDocument()` (returns metadata only)
- Optional `temporaryUploadStorage` property

3. **TemporaryUploadStorage** (defined in `types.ts`):

- New interface for upload session management
- `beginUpload()` instead of `initiateUpload()`
- `completeUpload()` returns `{ progress, getChunk }` for chunk retrieval
- `UploadProgress.chunks` is `Map<number, boolean>` instead of `Map<number, Uint8Array>`

4. **MilestoneStorage** (defined in `types.ts`):

- `createMilestone()` generates and returns ID (no `id` in input)
- Uses `Document["id"]` and `Milestone["id"]` for type safety

## Implementation Plan

### Phase 1: Verify Types and Create Temporary Upload Storage

1. **Verify `src/storage/types.ts` is complete**:

- **`src/storage/types.ts` is the source of truth** - all interfaces are defined here
- Verify all required interfaces exist: `DocumentStorage`, `FileStorage`, `TemporaryUploadStorage`, `MilestoneStorage`
- Verify all type definitions: `Document`, `File`, `FileMetadata`, `UploadProgress`, `DocumentMetadata`
- All implementations must import from `types.ts`, not from old files

2. **Create `src/storage/unstorage/temporary-upload-storage.ts`**:

- Import `TemporaryUploadStorage` interface from `src/storage/types.ts`
- Implement the interface exactly as defined in `types.ts`
- Implements: `beginUpload()`, `storeChunk()`, `getUploadProgress()`, `completeUpload()`, `cleanupExpiredUploads()`
- Handles upload sessions in unstorage backend

3. **Create `src/storage/in-memory/temporary-upload-storage.ts`**:

- Import `TemporaryUploadStorage` interface from `src/storage/types.ts`
- Implement the interface exactly as defined in `types.ts`
- Stores upload progress in memory maps

### Phase 2: Update Implementations

**Important**: All implementations must import interfaces from `src/storage/types.ts` and implement them exactly as defined there.

1. **Update `src/storage/unencrypted/document-storage.ts`**:

- Import `DocumentStorage` interface from `src/storage/types.ts`
- Change from `extends DocumentStorage` (old abstract class) to `implements DocumentStorage` (interface from types.ts)
- Update all method signatures to match the interface in `types.ts` exactly
- Update `handleSyncStep1()` to return `Document` (as defined in types.ts)
- Add `storageType: "unencrypted"` property (required by interface)
- Update to use `documentId: Document["id"] `instead of `key: string`

2. **Update `src/storage/encrypted/document-storage.ts`**:

- Import `DocumentStorage` interface from `src/storage/types.ts`
- Same changes as unencrypted, but `storageType: "encrypted"`
- Ensure encryption logic is preserved

3. **Update `src/storage/unstorage/unencrypted.ts`**:

- Import `DocumentStorage` interface from `src/storage/types.ts`
- Implement the interface exactly as defined in `types.ts`
- Update all method signatures to match `types.ts`
- Ensure composition with `fileStorage` and `milestoneStorage` works (both optional properties in interface)

4. **Update `src/storage/unstorage/encrypted.ts`**:

- Import `DocumentStorage` interface from `src/storage/types.ts`
- Same as unencrypted unstorage, but `storageType: "encrypted"`

5. **Update `src/storage/in-memory/ydoc.ts`**:

- Import `DocumentStorage` interface from `src/storage/types.ts`
- Implement the interface exactly as defined in `types.ts`

6. **Update `src/storage/unencrypted/file-storage.ts`**:

- Import `FileStorage` interface from `src/storage/types.ts`
- Change from `extends FileStorage` (old abstract class) to `implements FileStorage` (interface from types.ts)
- Remove `UploadStorage` inheritance (upload logic moved to `TemporaryUploadStorage`)
- Update method signatures to match `types.ts` exactly:
    - `getFile(fileId: File["id"]) `instead of `getFile(contentId: Uint8Array)`
    - `listFileMetadataByDocument()` returns `FileMetadata[]` (not full `FileData[]`)
- Accept optional `temporaryUploadStorage` in constructor for composition

7. **Update `src/storage/unstorage/file-storage.ts`**:

- Import `FileStorage` interface from `src/storage/types.ts`
- Implement the interface exactly as defined in `types.ts`
- Update all method signatures to match `types.ts`

8. **Update `src/storage/in-memory/file-storage.ts`**:

- Import `FileStorage` interface from `src/storage/types.ts`
- Implement the interface exactly as defined in `types.ts`
- Remove upload session management (moved to `TemporaryUploadStorage`)
- Accept optional `temporaryUploadStorage` in constructor for composition

9. **Update `src/storage/unstorage/milestone-storage.ts`**:

- Import `MilestoneStorage` interface from `src/storage/types.ts`
- Implement the interface exactly as defined in `types.ts`
- `createMilestone()` should generate ID internally and return it (no `id` in input params)
- Use `Document["id"]` and `Milestone["id"] `types from `types.ts`

10. **Update `src/storage/in-memory/milestone-storage.ts`**:

    - Import `MilestoneStorage` interface from `src/storage/types.ts`
    - Implement the interface exactly as defined in `types.ts`
    - `createMilestone()` should generate ID internally and return it
    - Use `Document["id"]` and `Milestone["id"] `types from `types.ts`

### Phase 3: Update Server Integration

1. **Update `src/server/session.ts`**:

- Update calls to use new method names (`handleUpdate` instead of `write`)
- Update `handleSyncStep1()` to work with `Document` return type
- Update file storage access via `storage.fileStorage`

2. **Update `src/server/file-handler.ts`**:

- Update to use `TemporaryUploadStorage` for uploads
- Access via `storage.fileStorage?.temporaryUploadStorage`
- Update method calls (`beginUpload` instead of `initiateUpload`)
- Update `completeUpload()` to use new return signature

3. **Update `src/server/server.ts`**:

- Update `deleteDocument()` call if needed
- Ensure file storage access works with new structure

### Phase 4: Update Tests

1. **Update `src/storage/in-memory/file-storage.test.ts`**:

- Update to new interface signatures
- Test `TemporaryUploadStorage` separately

2. **Update `src/storage/unstorage/file-storage.test.ts`**:

- Same updates

3. **Update `src/storage/in-memory/milestone-storage.test.ts`**:

- Update to new interface

4. **Update `src/storage/unstorage/milestone-storage.test.ts`**:

- Same updates

5. **Update `src/server/server.test.ts`**:

- Update mock `DocumentStorage` to new interface

6. **Update `src/http/server.test.ts`**:

- Update mock storage

### Phase 5: Update Examples and Playground

1. **Update `playground/bun/server.ts`**:

- Update storage instantiation to use new interfaces
- Compose `TemporaryUploadStorage` with `FileStorage`
- Compose `MilestoneStorage` with `DocumentStorage`

2. **Update `playground/bun/agent.ts`**:

- Same updates

3. **Update `playground/node/server.ts`**:

- Same updates

4. **Update `examples/excalidraw/backend/server.ts`**:

- Same updates

### Phase 6: Cleanup

1. **Delete old files**:

- `src/storage/document-storage.ts` (replaced by types.ts)
- `src/storage/file-storage.ts` (replaced by types.ts)
- `src/storage/milestone-storage.ts` (replaced by types.ts)

2. **Update `src/storage/index.ts`**:

- Export from `types.ts` instead of old files
- Ensure all exports are correct

3. **Update imports across codebase**:

- Find all imports of old files and update to `types.ts`
- Use grep to find all usages

## Composition Example

After migration, storage can be composed like:

```typescript
const documentStorage = new UnstorageDocumentStorage(redisStorage, {
  fileStorage: new UnstorageFileStorage(s3Storage, {
    temporaryUploadStorage: new UnstorageTemporaryUploadStorage(redisStorage)
  }),
  milestoneStorage: new S3MilestoneStorage(s3Storage) // Could use S3 for cold storage
});
```



## Migration Strategy

1. **Verify `src/storage/types.ts` is complete** - This is the source of truth for all interfaces
2. Create TemporaryUploadStorage implementations (foundation)
3. Update all storage implementations to import and implement interfaces from `types.ts`
4. Update server integration to use new API (import types from `types.ts`)
5. Update all tests to match new interfaces from `types.ts`
6. Update examples and playground code
7. Delete old interface files (`document-storage.ts`, `file-storage.ts`, `milestone-storage.ts`) and update exports