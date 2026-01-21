# Authentication

This guide demonstrates JWT token-based authentication for securing Teleportal connections. Both WebSocket and HTTP handlers verify tokens before allowing access.

## What it demonstrates

- Setting up JWT token authentication using `createTokenManager`
- Using `tokenAuthenticatedWebsocketHandler` and `tokenAuthenticatedHTTPHandler` for secure connections
- Configuring permission checks with `checkPermissionWithTokenManager`
- Creating and using JWT tokens on the client side with document access patterns and permissions
