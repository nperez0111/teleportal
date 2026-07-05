# JWT Token Utility for Collaborative Document Editing

This module provides a comprehensive JWT token utility for securing collaborative document editing sessions. It includes IAM-like permission management with support for document patterns, wildcards, and granular access control.

## Features

- **JWT-based authentication** using the `jose` library
- **IAM-like permission system** with granular document access control
- **Pattern matching** support for document names (exact, prefix, wildcard, suffix)
- **Room-based access control** for multi-tenant applications
- **Permission types**: `read`, `write`, `comment`, `suggest`, `admin`
- **Token expiration** and validation
- **Integration** with the teleportal websocket server

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

- **`read`**: Can view document content and awareness updates
- **`write`**: Can modify document content
- **`comment`**: Can add comments to documents
- **`suggest`**: Can make suggestions for document changes
- **`admin`**: Full access to all operations (supersedes other permissions)

## Document Pattern Matching

The token utility supports flexible document pattern matching:

### Exact Match

```typescript
pattern: "document1";
// Matches: "document1"
```

### Prefix Match

```typescript
pattern: "user/*";
// Matches: "user/doc1", "user/doc2", "user/project/doc3"
```

### Wildcard Match

```typescript
pattern: "*";
// Matches: any document name
```

### Suffix Match

```typescript
pattern: "*.md";
// Matches: "readme.md", "document.md"
```

### Complex Patterns

```typescript
pattern: "org/project/*";
// Matches: "org/project/doc1", "org/project/subfolder/doc2"
```

## Document Access Builder

For complex permission scenarios, you can use the `DocumentAccessBuilder` to construct `DocumentAccess[]` arrays with a fluent API:

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
  .write("user/*")
  .fullAccess("admin/*")
  .admin("super-admin/*")
  .build();

// Domain-specific methods
const access = new DocumentAccessBuilder()
  .ownDocuments("user-123")
  .allow("shared/*", ["read", "write"])
  .allow("projects/my-project/*", ["read", "write"])
  .build();

// Complex patterns with exclusions
const access = new DocumentAccessBuilder()
  .allowAll(["read", "write"])
  .deny("private/*")
  .deny("*.secret")
  .ownDocuments("user-456", ["read", "write", "comment", "suggest", "admin"])
  .allow("projects/important-project/*", ["read", "write", "comment", "suggest"])
  .admin("system/*")
  .build();
```

### Builder Methods

#### Basic Methods

- `allow(pattern, permissions)` - Allow access with specific permissions
- `deny(pattern)` - Deny access (exclusion pattern)
- `build()` - Return the constructed `DocumentAccess[]`

#### Permission Convenience Methods

- `readOnly(pattern)` - Read-only access
- `write(pattern)` - Read and write access
- `fullAccess(pattern)` - All permissions except admin
- `admin(pattern)` - Admin access (supersedes all other permissions)
- `commentOnly(pattern)` - Read and comment access
- `suggestOnly(pattern)` - Read and suggest access

#### Domain-Specific Methods

- `ownDocuments(userId, permissions?)` - User owns their documents (`userId/*`)

#### Denial Methods

- `denyDocument(documentName)` - Deny access to specific document

#### Global Access

- `allowAll(permissions?)` - Allow access to all documents (`*`)

## Usage Examples

### 1. Create a Token with Custom Access Patterns

```typescript
const token = await tokenManager.createToken("user-123", "org-456", [
  { pattern: "user-123/*", permissions: ["read", "write", "comment", "suggest"] },
  { pattern: "shared/*", permissions: ["read", "comment"] },
]);
```

### 2. Create an Admin Token

```typescript
// Admin has access to all documents in the room
const adminToken = await tokenManager.createAdminToken("admin-789", "org-456");
```

### 3. Verify and Check Permissions

```typescript
// Verify a token — the result is a discriminated union on `valid`
const result = await tokenManager.verifyToken(token);
if (!result.valid) {
  console.error(result.error); // `payload` is undefined, `error` is string
  return;
}

// TypeScript narrows: result.payload is TokenPayload, result.error is undefined
const canRead = tokenManager.hasDocumentPermission(result.payload, "user-123/document1", "read");
const canWrite = tokenManager.hasDocumentPermission(result.payload, "shared/document1", "write");

// Get all permissions for a document (aggregated across matching patterns)
const permissions = tokenManager.getDocumentPermissions(result.payload, "user-123/document1");
```

## Integration with WebSocket Server

Here's how to integrate the token utility with the websocket server:

```typescript
import { getWebsocketHandlers } from "teleportal/websocket-server";
import { Server } from "teleportal/server";
import { createTokenManager } from "teleportal/token";

const tokenManager = createTokenManager({
  secret: "your-secret-key",
  expiresIn: 3600,
});

const server = new Server({
  storage: async (ctx) => documentStorage,
  checkPermission: async ({ context, documentId, rpcMethod, message, type }) => {
    const token = (context as any).token;
    if (!token) return false;

    const result = await tokenManager.verifyToken(token);
    if (!result.valid || !result.payload) return false;

    if (result.payload.room !== context.room) return false;

    if (documentId) {
      const requiredPermission = type === "read" ? "read" : "write";
      return tokenManager.hasDocumentPermission(result.payload, documentId, requiredPermission);
    }

    return true;
  },
});

const handlers = getWebsocketHandlers({
  onUpgrade: async (request) => {
    // Extract token from request
    const url = new URL(request.url);
    const token =
      url.searchParams.get("token") || request.headers.get("authorization")?.replace("Bearer ", "");

    if (!token) {
      throw new Response("No token provided", { status: 401 });
    }

    // Verify token (jose checks expiration, issuer, and audience automatically)
    const result = await tokenManager.verifyToken(token);
    if (!result.valid) {
      throw new Response(result.error, { status: 401 });
    }

    return {
      context: {
        userId: result.payload.userId,
        room: result.payload.room,
        token, // Pass token for permission checking
      },
    };
  },
});
```

## API Reference

### TokenManager

#### Constructor

```typescript
new TokenManager(options: TokenOptions)
```

#### Methods

- `createToken(userId, room, documentPatterns, options?)`: Create a JWT token with specific access patterns
- `createAdminToken(userId, room, options?)`: Create an admin token with full access
- `verifyToken(token)`: Verify and decode a JWT token
- `hasDocumentPermission(payload, documentName, permission)`: Check if user has permission
- `getDocumentPermissions(payload, documentName)`: Get all permissions for a document

### Utility Functions

- `createTokenManager(options)`: Create a TokenManager instance
- `extractContextFromToken(payload)`: Extract userId and room from token
- `isTokenExpired(payload)`: Check if token has expired

## Security Considerations

1. **Use strong secrets**: Generate cryptographically secure random secrets (at least 256 bits)
2. **Set appropriate expiration**: Don't make tokens too long-lived
3. **Validate room access**: Always check that the user is in the correct room
4. **Check permissions on every operation**: Don't cache permission results
5. **Use HTTPS/WSS**: Always use secure connections in production
6. **Rotate secrets**: Regularly rotate your JWT signing secrets
7. **Expiration is enforced**: `verifyToken` automatically rejects expired tokens via `jose` -- no manual check needed

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
  aud?: string;           // Audience (default: "teleportal")
}
```

## Error Handling

The token utility provides detailed error information:

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
