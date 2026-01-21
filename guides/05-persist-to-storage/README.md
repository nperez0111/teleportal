# Persist to Storage

This guide demonstrates using persistent storage instead of in-memory storage. Documents are persisted across server restarts using the unstorage abstraction layer.

## What it demonstrates

- Using `UnstorageDocumentStorage` for persistent document storage
- Configuring unstorage with different drivers (memory, SQLite, Redis, etc.)
- Replacing in-memory storage with a persistent storage backend
- The flexibility of Teleportal's storage abstraction layer
