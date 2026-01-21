# Custom Storage

This guide demonstrates how to create a custom storage implementation by extending `UnencryptedDocumentStorage`. This example shows an in-memory storage that merges updates on-the-fly.

## What it demonstrates

- Creating a custom storage implementation by extending `UnencryptedDocumentStorage`
- Implementing required methods: `handleUpdate`, `getDocument`, `writeDocumentMetadata`, `getDocumentMetadata`, and `deleteDocument`
- Using utility functions like `mergeUpdates` and `getStateVectorFromUpdate` for document management
- Building storage backends tailored to specific use cases or performance requirements
