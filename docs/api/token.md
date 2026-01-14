# Token API

Complete API reference for Teleportal JWT token utilities.

## TokenManager

Main class for managing JWT tokens.

### Constructor

```typescript
new TokenManager(options: TokenOptions)
```

### Options

```typescript
interface TokenOptions {
  secret: string;           // JWT signing secret
  expiresIn?: number;      // Token expiration in seconds
  issuer?: string;         // Token issuer
  audience?: string;       // Token audience (default: "teleportal")
}
```

### Methods

#### `createToken(userId, room, documentAccess, options?)`

Generates a JWT token.

```typescript
createToken(
  userId: string,
  room: string,
  documentAccess: DocumentAccess[],
  options?: TokenCreateOptions
): Promise<string>
```

#### `verifyToken(token)`

Verifies and decodes a JWT token.

```typescript
verifyToken(token: string): Promise<{
  valid: boolean;
  payload?: TokenPayload;
  error?: string;
}>
```

#### `hasDocumentPermission(payload, documentName, permission)`

Checks if user has permission for a document.

```typescript
hasDocumentPermission(
  payload: TokenPayload,
  documentName: string,
  permission: Permission
): boolean
```

#### `getDocumentPermissions(payload, documentName)`

Gets all permissions for a document.

```typescript
getDocumentPermissions(
  payload: TokenPayload,
  documentName: string
): Permission[]
```

#### `createUserToken(userId, room, permissions?, options?)`

Creates a token for user-owned documents.

```typescript
createUserToken(
  userId: string,
  room: string,
  permissions?: Permission[],
  options?: TokenCreateOptions
): Promise<string>
```

#### `createAdminToken(userId, room, options?)`

Creates an admin token.

```typescript
createAdminToken(
  userId: string,
  room: string,
  options?: TokenCreateOptions
): Promise<string>
```

#### `createDocumentToken(userId, room, documentPatterns, options?)`

Creates a custom token with specific document access.

```typescript
createDocumentToken(
  userId: string,
  room: string,
  documentPatterns: DocumentAccess[],
  options?: TokenCreateOptions
): Promise<string>
```

## DocumentAccessBuilder

Builder for constructing document access patterns.

### Methods

#### `allow(pattern, permissions)`

Allows access with specific permissions.

```typescript
allow(pattern: string, permissions: Permission[]): DocumentAccessBuilder
```

#### `deny(pattern)`

Denies access (exclusion pattern).

```typescript
deny(pattern: string): DocumentAccessBuilder
```

#### `readOnly(pattern)`

Read-only access.

```typescript
readOnly(pattern: string): DocumentAccessBuilder
```

#### `readWrite(pattern)`

Read and write access.

```typescript
readWrite(pattern: string): DocumentAccessBuilder
```

#### `admin(pattern)`

Admin access.

```typescript
admin(pattern: string): DocumentAccessBuilder
```

#### `build()`

Returns the constructed document access array.

```typescript
build(): DocumentAccess[]
```

## Utility Functions

### `createTokenManager(options)`

Creates a TokenManager instance.

```typescript
createTokenManager(options: TokenOptions): TokenManager
```

### `extractContextFromToken(payload)`

Extracts userId and room from token payload.

```typescript
extractContextFromToken(payload: TokenPayload): {
  userId: string;
  room: string;
}
```

### `isTokenExpired(payload)`

Checks if token has expired.

```typescript
isTokenExpired(payload: TokenPayload): boolean
```

## Types

### Permission

```typescript
type Permission = "read" | "write" | "comment" | "suggest" | "admin"
```

### DocumentAccess

```typescript
interface DocumentAccess {
  pattern: string;
  permissions: Permission[];
}
```

### TokenPayload

```typescript
interface TokenPayload {
  userId: string;
  room: string;
  documentAccess: DocumentAccess[];
  exp?: number;
  iat?: number;
  iss?: string;
  aud: "teleportal";
}
```

## Examples

See the [Authentication Guide](../../guide/authentication.md) for complete examples.
