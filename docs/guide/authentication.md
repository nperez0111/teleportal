# Authentication

Teleportal provides JWT-based authentication with IAM-like permission management for securing collaborative document editing sessions.

## Quick Start

```typescript
import { createTokenManager } from "teleportal/token";

// Create a token manager
const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

// Generate a token for a user
const token = await tokenManager.createToken("user-123", "org-456", [
  { pattern: "*", permissions: ["admin"] },
]);
```

## Permission Types

- **`read`** - Can view document content and awareness updates
- **`write`** - Can modify document content
- **`comment`** - Can add comments to documents
- **`suggest`** - Can make suggestions for document changes
- **`admin`** - Full access to all operations (supersedes other permissions)

## Document Pattern Matching

### Exact Match

```typescript
pattern: "document1"
// Matches: "document1"
```

### Prefix Match

```typescript
pattern: "user/*"
// Matches: "user/doc1", "user/doc2", "user/project/doc3"
```

### Wildcard Match

```typescript
pattern: "*"
// Matches: any document name
```

### Suffix Match

```typescript
pattern: "*.md"
// Matches: "readme.md", "document.md"
```

## Document Access Builder

For complex permission scenarios, use the `DocumentAccessBuilder`:

```typescript
import { DocumentAccessBuilder } from "teleportal/token";

// Basic usage
const access = new DocumentAccessBuilder()
  .allow("user/*", ["read", "write"])
  .deny("private/*")
  .build();

// Using convenience methods
const access = new DocumentAccessBuilder()
  .readOnly("public/*")
  .readWrite("user/*")
  .fullAccess("admin/*")
  .admin("super-admin/*")
  .build();

// Domain-specific methods
const access = new DocumentAccessBuilder()
  .ownDocuments("user-123")
  .sharedDocuments()
  .projectDocuments("my-project")
  .orgDocuments("acme-corp")
  .build();
```

## Creating Tokens

### Regular User Token

```typescript
const userToken = await tokenManager.createUserToken("user-123", "org-456", [
  "read", "write", "comment", "suggest"
]);
```

### Admin Token

```typescript
const adminToken = await tokenManager.createAdminToken("admin-789", "org-456");
```

### Custom Token

```typescript
const customToken = await tokenManager.createDocumentToken("user-101", "org-456", [
  {
    pattern: "shared/*",
    permissions: ["read", "comment"]
  },
  {
    pattern: "projects/my-project/*",
    permissions: ["read", "write", "comment", "suggest"]
  },
  {
    pattern: "user-101/*",
    permissions: ["read", "write", "comment", "suggest", "admin"]
  }
]);
```

## Server Integration

### WebSocket Server

```typescript
import { getWebsocketHandlers } from "teleportal/websocket-server";
import { createTokenManager } from "teleportal/token";

const tokenManager = createTokenManager({
  secret: "your-secret-key",
  expiresIn: 3600,
});

const handlers = getWebsocketHandlers({
  onUpgrade: async (request) => {
    // Extract token from query string or headers
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ||
                 request.headers.get("authorization")?.replace("Bearer ", "");

    if (!token) {
      throw new Response("No token provided", { status: 401 });
    }

    // Verify token
    const result = await tokenManager.verifyToken(token);
    if (!result.valid || !result.payload) {
      throw new Response("Invalid token", { status: 401 });
    }

    return {
      context: {
        userId: result.payload.userId,
        room: result.payload.room,
        token,
      },
    };
  },
  onConnect: async ({ transport, context, id }) => {
    await server.createClient(transport, context, id);
  },
  onDisconnect: async (id) => {
    await server.disconnectClient(id);
  },
});
```

### Permission Checking

```typescript
const server = new Server({
  getStorage: async (ctx) => {
    // ... storage setup
  },
  checkPermission: async ({ context, documentId, message }) => {
    const token = (context as any).token;
    if (!token) return false;

    // Verify token
    const result = await tokenManager.verifyToken(token);
    if (!result.valid || !result.payload) return false;

    const payload = result.payload;

    // Check room access
    if (payload.room !== context.room) return false;

    // Handle file messages
    if (message.type === "file") {
      // File-specific permission checks
      return true;
    }

    // Check document permissions
    if (!documentId) {
      throw new Error("documentId is required for doc messages");
    }
    const requiredPermission = message.type === "awareness" ? "read" : "write";
    return tokenManager.hasDocumentPermission(payload, documentId, requiredPermission);
  },
});
```

## Client Integration

### WebSocket Connection

```typescript
import { Provider } from "teleportal/providers";

const provider = await Provider.create({
  url: `ws://localhost:3000?token=${token}`,
  document: "my-document",
});
```

### HTTP Connection

```typescript
import { HttpConnection } from "teleportal/providers/http";

const connection = new HttpConnection({
  url: "http://localhost:3000",
  headers: {
    Authorization: `Bearer ${token}`,
  },
});

const provider = new Provider({
  client: connection,
  document: "my-document",
});
```

## Verifying Tokens

```typescript
// Verify a token
const result = await tokenManager.verifyToken(token);
if (result.valid && result.payload) {
  // Check specific permissions
  const canRead = tokenManager.hasDocumentPermission(
    result.payload,
    "user-123/document1",
    "read"
  );

  const canWrite = tokenManager.hasDocumentPermission(
    result.payload,
    "shared/document1",
    "write"
  );

  // Get all permissions for a document
  const permissions = tokenManager.getDocumentPermissions(
    result.payload,
    "user-123/document1"
  );
}
```

## Token Payload Structure

```typescript
{
  userId: string;           // User identifier
  room: string;            // Room/organization identifier
  documentAccess: [        // Document access patterns
    {
      pattern: string;     // Document pattern
      permissions: Permission[]; // Array of permissions
    }
  ];
  exp?: number;           // Expiration time (Unix timestamp)
  iat?: number;           // Issued at time (Unix timestamp)
  iss?: string;           // Issuer
  aud: "teleportal";      // Audience
}
```

## Security Considerations

1. **Use strong secrets** - Generate cryptographically secure random secrets
2. **Set appropriate expiration** - Don't make tokens too long-lived
3. **Validate room access** - Always check that the user is in the correct room
4. **Check permissions on every operation** - Don't cache permission results
5. **Use HTTPS** - Always use secure connections in production
6. **Rotate secrets** - Regularly rotate your JWT signing secrets

## Error Handling

```typescript
const result = await tokenManager.verifyToken(token);
if (!result.valid) {
  console.error("Token verification failed:", result.error);
  // Handle invalid token
}
```

Common error scenarios:
- Invalid signature
- Expired token
- Invalid issuer/audience
- Malformed token
- Missing required claims

## Next Steps

- [Server Setup](./server-setup.md) - Set up authentication in your server
- [Provider Setup](./provider-setup.md) - Connect clients with authentication
- [API Reference](../api/token.md) - Complete token API documentation
