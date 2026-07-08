# Custom Storage

This guide demonstrates how to create a custom storage implementation by extending `AbstractDocumentStorage`. This example shows an in-memory storage that uses the merge-on-read pattern.

## What it demonstrates

- Creating a custom storage implementation by extending `AbstractDocumentStorage`
- Implementing required abstract methods: `appendUpdate`, `getPendingUpdates`, `clearPendingUpdates`, `getBaseState`, `replaceBaseState`, `writeDocumentMetadata`, `getDocumentMetadata`, and `deleteDocument`
- Using the merge-on-read pattern where updates are appended to a pending log and merged when the document is read
- Building storage backends tailored to specific use cases or performance requirements
