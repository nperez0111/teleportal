# JWT Token Utility for Collaborative Document Editing

This module provides a comprehensive JWT token utility for securing collaborative document editing sessions. It includes IAM-like permission management with support for document patterns, wildcards, and granular access control.

## Features

- **JWT-based authentication** using the `jose` library
- **IAM-like permission system** with granular document access control
- **Pattern matching** support for document names (exact, prefix, wildcard, suffix)
- **Room-based access control** for multi-tenant applications
- **Permission types**: `read`, `write`, `comment`, `suggest`, `admin`
- **Token expiration** and validation
- **Integration** with the match-maker websocket server

## Quick Start

```typescript
import { createTokenManager } from "match-maker/token";

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

### Complex Patterns

```typescript
pattern: "org/project/*"
// Matches: "org/project/doc1", "org/project/subfolder/doc2"
```

## Document Access Builder

For complex permission scenarios, you can use the `DocumentAccessBuilder` to construct `DocumentAccess[]` arrays with a fluent API:

```typescript
import { DocumentAccessBuilder } from "match-maker/token";

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

// Complex patterns with exclusions
const access = new DocumentAccessBuilder()
  .allowAll(["read", "write"])
  .denyPrivate()
  .denySecrets()
  .ownDocuments("user-456", ["read", "write", "comment", "suggest", "admin"])
  .projectDocuments("important-project", ["read", "write", "comment", "suggest"])
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
- `writeOnly(pattern)` - Write-only access
- `readWrite(pattern)` - Read and write access
- `fullAccess(pattern)` - All permissions except admin
- `admin(pattern)` - Admin access (supersedes all other permissions)
- `commentOnly(pattern)` - Read and comment access
- `suggestOnly(pattern)` - Read and suggest access

#### Domain-Specific Methods
- `ownDocuments(userId, permissions?)` - User owns their documents (`userId/*`)
- `sharedDocuments(permissions?)` - Access to shared documents (`shared/*`)
- `projectDocuments(projectName, permissions?)` - Access to project documents (`projects/projectName/*`)
- `orgDocuments(orgName, permissions?)` - Access to organization documents (`orgName/*`)

#### Denial Convenience Methods
- `denyPrivate()` - Deny access to private documents (`!private/*`)
- `denySecrets()` - Deny access to secret files (`!*.secret`)
- `denyAdmin()` - Deny access to admin documents (`!admin/*`)
- `denyDocument(documentName)` - Deny access to specific document

#### Global Access
- `allowAll(permissions?)` - Allow access to all documents (`*`)

## Usage Examples

### 1. Create a Regular User Token

```typescript
// User owns all documents starting with their userId
const userToken = await tokenManager.createUserToken("user-123", "org-456", [
  "read", "write", "comment", "suggest"
]);
```

### 2. Create an Admin Token

```typescript
// Admin has access to all documents in the room
const adminToken = await tokenManager.createAdminToken("admin-789", "org-456");
```

### 3. Create a Custom Token with Specific Access

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

### 4. Verify and Check Permissions

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

## Integration with WebSocket Server

Here's how to integrate the token utility with the websocket server:

```typescript
import { getWebsocketHandlers } from "match-maker/websocket-server";
import { Server } from "match-maker/server";
import { createTokenManager } from "match-maker/token";

const tokenManager = createTokenManager({
  secret: "your-secret-key",
  expiresIn: 3600,
});

const server = new Server({
  getStorage: async ({ context }) => {
    // Your storage implementation
    return {} as any;
  },
  checkPermission: async ({ context, document, message }) => {
    // Extract token from context
    const token = (context as any).token;
    if (!token) return false;

    // Verify token
    const result = await tokenManager.verifyToken(token);
    if (!result.valid || !result.payload) return false;

    const payload = result.payload;

    // Check room access
    if (payload.room !== context.room) return false;

    // Check document permissions
    const requiredPermission = message.type === "awareness" ? "read" : "write";
    return tokenManager.hasDocumentPermission(payload, document, requiredPermission);
  },
});

const handlers = getWebsocketHandlers({
  onUpgrade: async (request) => {
    // Extract token from request
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

    const payload = result.payload;

    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      throw new Response("Token expired", { status: 401 });
    }

    return {
      context: {
        userId: payload.userId,
        room: payload.room,
        token, // Pass token for permission checking
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

## API Reference

### TokenManager

#### Constructor

```typescript
new TokenManager(options: TokenOptions)
```

#### Methods

- `generateToken(userId, room, documentAccess, options?)`: Generate a JWT token
- `verifyToken(token)`: Verify and decode a JWT token
- `hasDocumentPermission(payload, documentName, permission)`: Check if user has permission
- `getDocumentPermissions(payload, documentName)`: Get all permissions for a document
- `createUserToken(userId, room, permissions?, options?)`: Create token for user-owned documents
- `createAdminToken(userId, room, options?)`: Create admin token
- `createDocumentToken(userId, room, documentPatterns, options?)`: Create custom token

### Utility Functions

- `createTokenManager(options)`: Create a TokenManager instance
- `extractContextFromToken(payload)`: Extract userId and room from token
- `isTokenExpired(payload)`: Check if token has expired

## Security Considerations

1. **Use strong secrets**: Generate cryptographically secure random secrets
2. **Set appropriate expiration**: Don't make tokens too long-lived
3. **Validate room access**: Always check that the user is in the correct room
4. **Check permissions on every operation**: Don't cache permission results
5. **Use HTTPS**: Always use secure connections in production
6. **Rotate secrets**: Regularly rotate your JWT signing secrets

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
  aud: "match-maker";           // Audience
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
