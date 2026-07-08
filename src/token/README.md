# `teleportal/token` — JWT auth & document permissions

`TokenManager` mints and verifies HMAC-signed JWTs and evaluates an IAM-style
document-access policy (glob patterns + permissions) carried inside each token.

## Why it exists

The sync server needs a stateless way to answer two questions on every message:

1. **Who is this?** — `userId` + `room`, proven by a signed token.
2. **May they do this to this document?** — `hasDocumentPermission(payload, doc, perm)`.

Tokens are minted by your application server (which holds the signing secret) and
handed to clients. The sync server verifies the token on connect and calls
`hasDocumentPermission` per message (see `src/server/check-permission.ts`). The
signing secret never leaves your servers.

## How it works

- **Signing / verifying**: built on [`jose`](https://github.com/panva/jose).
  Tokens are always signed with **HS256** (symmetric HMAC-SHA-256).
  `verifyToken` pins `algorithms: ["HS256"]`, so HS384/HS512 tokens — and
  unsecured `alg: "none"` tokens (which `jose` never accepts) — are rejected.
- **Claims**: `iss` (issuer), `aud` (audience), `iat`, `exp` are set at mint time
  and enforced by `jose` at verify time. A wrong issuer, wrong audience, or an
  expired token all fail verification.
- **Policy**: `documentAccess` is a list of `{ pattern, permissions }` rules.
  Patterns are globs (see below). `admin` in a matching rule implies every
  permission for that pattern. `!`-prefixed patterns are _exclusions_.

### Verification result

`verifyToken` returns a discriminated union — never throws:

```typescript
const result = await tokenManager.verifyToken(token);
if (!result.valid) {
  // result.payload is undefined, result.error is a string
  return respond(401, result.error);
}
// result.payload is TokenPayload, result.error is undefined
```

## Public API

### `createTokenManager(options: TokenOptions): TokenManager`

| Option      | Type                   | Default        | Notes                    |
| ----------- | ---------------------- | -------------- | ------------------------ |
| `secret`    | `string \| Uint8Array` | — (required)   | HMAC key. Use ≥256 bits. |
| `expiresIn` | `number` (seconds)     | `3600`         | Default token lifetime.  |
| `issuer`    | `string`               | `"teleportal"` | Set as `iss`, enforced.  |
| `audience`  | `string`               | `"teleportal"` | Set as `aud`, enforced.  |

### `TokenManager` methods

- `createToken(userId, room, documentPatterns, options?)` → signed JWT string.
- `createAdminToken(userId, room, options?)` → JWT with a single `{ pattern: "*", permissions: ["admin"] }` rule.
- `generateToken(userId, room, documentAccess, options?)` → the underlying mint call used by the two above.
- `verifyToken(token)` → `TokenVerificationResult` (discriminated on `valid`).
- `hasDocumentPermission(payload, documentName, requiredPermission)` → `boolean`.
- `getDocumentPermissions(payload, documentName)` → deduplicated `Permission[]` aggregated across all matching inclusion rules (empty if any exclusion matches).

`options` on the mint methods can override `expiresIn`, `issuer`, `audience` per token.

### Standalone functions

- `createTokenManager(options)` — factory for `TokenManager`.
- `extractContextFromToken(payload)` → `{ userId, room }`. Pure projection; does **not** verify — only call it on a payload from a successful `verifyToken`.
- `isTokenExpired(payload)` → `boolean`. Convenience check against `payload.exp`; returns `false` when `exp` is absent. `verifyToken` already enforces expiry, so this is only for inspecting an already-decoded payload.

### `DocumentAccessBuilder`

Fluent builder for `DocumentAccess[]`. Methods (all chainable, `build()` returns the array):

| Method                         | Produced rule                                                           |
| ------------------------------ | ----------------------------------------------------------------------- |
| `allow(pattern, perms)`        | `{ pattern, permissions: perms }`                                       |
| `deny(pattern)`                | `{ pattern: "!"+pattern, permissions: [all] }`                          |
| `denyDocument(name)`           | alias of `deny(name)`                                                   |
| `allowAll(perms?)`             | `allow("*", perms ?? [read,write,comment,suggest])`                     |
| `readOnly(pattern)`            | `allow(pattern, ["read"])`                                              |
| `write(pattern)`               | `allow(pattern, ["read","write"])`                                      |
| `fullAccess(pattern)`          | `allow(pattern, ["read","write","comment","suggest"])` (**no `admin`**) |
| `admin(pattern)`               | `allow(pattern, ["admin"])`                                             |
| `commentOnly(pattern)`         | `allow(pattern, ["read","comment"])`                                    |
| `suggestOnly(pattern)`         | `allow(pattern, ["read","comment","suggest"])`                          |
| `ownDocuments(userId, perms?)` | `allow(userId+"/*", perms ?? [read,write,comment,suggest,admin])`       |

> Note: the permission array attached to a `deny` rule is ignored — only the
> pattern matters for exclusions.

## Permission types

`read`, `write`, `comment`, `suggest`, `admin`. `admin` in a matching rule
grants every permission for that pattern (it is checked as a wildcard inside
`hasDocumentPermission`).

## Pattern matching

`*` is the **only** wildcard and matches any run of characters (including
none). Every other character is matched **literally** — patterns are compiled to
an anchored `RegExp` with all regex metacharacters escaped, so a pattern such as
`logs[prod]*` matches the literal text `logs[prod]…` and never behaves as a
regex character class. (This escaping is a security boundary: patterns and
document names must not be able to inject regex syntax.)

| Pattern  | Matches               | Does **not** match    |
| -------- | --------------------- | --------------------- |
| `doc1`   | `doc1`                | `doc10`, `doc`        |
| `*`      | anything              | —                     |
| `user/*` | `user/a`, `user/a/b`  | `user` (bare, no `/`) |
| `*.md`   | `readme.md`, `a/b.md` | `notes.txt`           |
| `a*b`    | `ab`, `axb`           | `axbc`                |

### Exclusions

A rule whose `pattern` starts with `!` is an exclusion. Evaluation:

- If **any** exclusion rule matches the document → **denied** (returns `false` /
  `[]`), regardless of inclusions.
- Otherwise, if any inclusion rule matches **and** grants the required
  permission (or `admin`) → allowed.
- Otherwise → denied.

```typescript
new DocumentAccessBuilder()
  .allowAll(["read", "write"]) // grant everything…
  .deny("private/*") // …except the private/ tree
  .build();
```

## Integrating with the server

```typescript
import { createTokenManager } from "teleportal/token";

const tokenManager = createTokenManager({ secret: process.env.JWT_SECRET! });

// On upgrade: verify once, stash the payload fields on the connection context.
const result = await tokenManager.verifyToken(token);
if (!result.valid) throw new Response(result.error, { status: 401 });

// Per message: the server calls hasDocumentPermission (see
// src/server/check-permission.ts, checkPermissionWithTokenManager).
```

## Security model & gotchas

1. **Fail-OPEN when `documentAccess` is absent.** `hasDocumentPermission`
   returns `true` for **every** document/permission when a token has no
   `documentAccess` claim. This is deliberate ("an unrestricted, room-scoped
   token"), but it is a footgun: a token minted without an access policy is
   effectively an admin token for its room. Always attach `documentAccess`
   (or use `createAdminToken` explicitly) unless you intend room-wide access.
   Note the asymmetry: `getDocumentPermissions` fails **closed** (returns `[]`)
   for the same missing claim.
2. **Room is not auto-checked.** `hasDocumentPermission` ignores `payload.room`.
   The caller must compare `payload.room` to the connection's room itself.
3. **Algorithm is pinned to HS256.** Do not change the mint algorithm without
   updating the `algorithms` allowlist in `verifyToken`.
4. **`extractContextFromToken` / `isTokenExpired` do not verify signatures.**
   Only feed them a payload from a successful `verifyToken`.
5. **Use a strong secret (≥256 bits) and HTTPS/WSS.** `jose` does not enforce a
   minimum HMAC key length; that is on you.
6. **`fullAccess` excludes `admin`.** Use `admin(pattern)` (or include `admin`
   explicitly) when you want the admin permission.

## `TokenPayload`

```typescript
type TokenPayload = {
  userId: string;
  room: string;
  documentAccess?: DocumentAccess[]; // optional — absent ⇒ fail-open (see gotcha #1)
  exp?: number; // set + enforced by verifyToken
  iat?: number;
  iss?: string; // set + enforced
  aud?: string; // set + enforced (default "teleportal")
};
```
