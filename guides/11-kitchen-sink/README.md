# Kitchen Sink

This guide demonstrates a comprehensive, production-ready Teleportal server that combines nearly all major features of the framework. This is the most feature-complete example and shows how everything works together.

## What it demonstrates

- **Encryption at rest** - Documents stored encrypted using `createEncryptedDriver` with AES-256-GCM
- **JWT token-based authentication** - Using `createTokenManager` for secure access control
- **Permission checking** - Authorization via `checkPermissionWithTokenManager`
- **Multi-tier rate limiting** - Protection against abuse with:
  - Per-user limits (100 messages/second)
  - Per-document limits (500 messages/10 seconds)
  - Per user-document pair limits (100 messages/second)
  - Message size limits (10MB maximum)
  - Shared storage backend for multi-node deployments
- **Protocol extensions**:
  - **Milestones** - Snapshot and version management via `getMilestoneRpcHandlers`
  - **File Upload** - Binary file handling via `getFileRpcHandlers`
- **Dual transport support** - Both WebSocket and HTTP fallback
- **Multiple storage backends** - Using Unstorage with separate storage instances for:
  - Document storage (encrypted/unencrypted based on context)
  - Milestone storage
  - File storage
  - Rate limit storage

## Security note

The example uses placeholder secrets for demonstration purposes. In production, you should:

- Use strong, randomly generated secrets for JWT token signing
- Store encryption keys securely (e.g., environment variables, key management services)
- Implement proper key rotation policies
- Use production-grade storage backends (Redis, PostgreSQL, etc.) instead of in-memory storage
