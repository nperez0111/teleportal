import { SignJWT, jwtVerify } from "jose";

export * from "./check-permission";

export type Permission = "admin" | "write" | "read" | "comment" | "suggest";

export type DocumentAccess = {
  /**
   * Document name pattern. Supports wildcards and prefixes.
   * Examples:
   * - "doc1" - exact match
   * - "user/*" - all documents starting with "user/"
   * - "*" - all documents
   * - "org/project/*" - all documents in org/project/
   */
  pattern: string;
  permissions: Permission[];
};

export type TokenPayload = {
  /**
   * User identifier
   */
  userId: string;
  /**
   * Room/organization identifier
   */
  room: string;
  /**
   * Document access patterns and permissions
   */
  documentAccess: DocumentAccess[];
  /**
   * Token expiration time (Unix timestamp)
   */
  exp?: number;
  /**
   * Token issued at time (Unix timestamp)
   */
  iat?: number;
  /**
   * Token issuer
   */
  iss?: string;
  /**
   * Token audience
   */
  aud?: string;
};

export type TokenOptions = {
  /**
   * Secret key for signing JWT tokens
   */
  secret: string | Uint8Array;
  /**
   * Token expiration time in seconds (default: 1 hour)
   */
  expiresIn?: number;
  /**
   * Token issuer (default: "teleportal")
   */
  issuer?: string;
};

export type TokenVerificationResult =
  | {
      /**
       * Whether the token is valid
       */
      valid: true;
      /**
       * The decoded token payload (if valid)
       */
      payload: TokenPayload;
      /**
       * Error message (if invalid)
       */
      error: undefined;
    }
  | {
      /**
       * Whether the token is valid
       */
      valid: boolean;
      /**
       * The decoded token payload (if valid)
       */
      payload: undefined;
      /**
       * Error message (if invalid)
       */
      error: string;
    };

/**
 * Utility class for generating and verifying JWT tokens for collaborative document editing
 */
export class TokenManager {
  private secret: Uint8Array;
  private expiresIn: number;
  private issuer: string;

  constructor(options: TokenOptions) {
    this.secret =
      typeof options.secret === "string"
        ? new TextEncoder().encode(options.secret)
        : options.secret;
    this.expiresIn = options.expiresIn ?? 3600; // 1 hour default
    this.issuer = options.issuer ?? "teleportal";
  }

  /**
   * Generate a JWT token for a user with specified document access permissions
   */
  async generateToken(
    userId: string,
    room: string,
    documentAccess: DocumentAccess[],
    options?: {
      expiresIn?: number;
      issuer?: string;
      audience?: string;
    },
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + (options?.expiresIn ?? this.expiresIn);

    const payload: TokenPayload = {
      userId,
      room,
      documentAccess,
      exp,
      iat: now,
      iss: options?.issuer ?? this.issuer,
      aud: "teleportal",
    };

    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setIssuer(payload.iss!)
      .setAudience(payload.aud!)
      .sign(this.secret);

    return jwt;
  }

  /**
   * Verify and decode a JWT token
   */
  async verifyToken(token: string): Promise<TokenVerificationResult> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
        audience: "teleportal",
      });

      return {
        valid: true,
        payload: payload as TokenPayload,
        error: undefined,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Unknown error",
        payload: undefined,
      };
    }
  }

  /**
   * Check if a user has permission to access a specific document
   */
  hasDocumentPermission(
    payload: TokenPayload,
    documentName: string,
    requiredPermission: Permission,
  ): boolean {
    let inclusionMatched = false;
    let exclusionMatched = false;

    for (const access of payload.documentAccess) {
      if (access.pattern.startsWith("!")) {
        // This is an exclusion pattern - check if the document matches the pattern after the !
        const excludePattern = access.pattern.slice(1);
        const matches = this.matchesPattern(excludePattern, documentName);

        if (matches) {
          exclusionMatched = true;
        }
      } else {
        // This is an inclusion pattern
        const matches = this.matchesPattern(access.pattern, documentName);

        if (
          matches &&
          (access.permissions.includes(requiredPermission) ||
            access.permissions.includes("admin"))
        ) {
          inclusionMatched = true;
        }
      }
    }

    if (exclusionMatched) return false;
    if (inclusionMatched) return true;
    return false;
  }

  /**
   * Get all permissions for a specific document
   */
  getDocumentPermissions(
    payload: TokenPayload,
    documentName: string,
  ): Permission[] {
    const matchingAccess = payload.documentAccess.find((access) =>
      this.matchesPattern(access.pattern, documentName),
    );

    return matchingAccess?.permissions ?? [];
  }

  /**
   * Check if a pattern matches a document name
   * Supports wildcards, prefix matching, and exclusion patterns
   */
  private matchesPattern(pattern: string, documentName: string): boolean {
    // Exact match
    if (pattern === documentName) {
      return true;
    }

    // Wildcard match
    if (pattern === "*") {
      return true;
    }

    // Prefix match (ends with /*)
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      return documentName.startsWith(prefix + "/");
    }

    // Suffix match (starts with *)
    if (pattern.startsWith("*")) {
      const suffix = pattern.slice(1);
      return documentName.endsWith(suffix);
    }

    // Simple wildcard match (contains *)
    if (pattern.includes("*")) {
      const regexPattern = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*");
      const regex = new RegExp(`^${regexPattern}$`);
      return regex.test(documentName);
    }

    return false;
  }

  /**
   * Create a token for an admin user with access to all documents in a room
   */
  async createAdminToken(
    userId: string,
    room: string,
    options?: {
      expiresIn?: number;
      issuer?: string;
      audience?: string;
    },
  ): Promise<string> {
    const documentAccess: DocumentAccess[] = [
      {
        pattern: "*",
        permissions: ["admin"],
      },
    ];

    return this.generateToken(userId, room, documentAccess, options);
  }

  /**
   * Create a token for a user with specific document access
   */
  async createToken(
    userId: string,
    room: string,
    documentPatterns: Array<{
      pattern: string;
      permissions: Permission[];
    }>,
    options?: {
      expiresIn?: number;
      issuer?: string;
      audience?: string;
    },
  ): Promise<string> {
    const documentAccess: DocumentAccess[] = documentPatterns.map(
      ({ pattern, permissions }) => ({
        pattern,
        permissions,
      }),
    );

    return this.generateToken(userId, room, documentAccess, options);
  }
}

/**
 * Utility function to create a TokenManager instance
 */
export function createTokenManager(options: TokenOptions): TokenManager {
  return new TokenManager(options);
}

/**
 * Utility function to extract context from a verified token
 * This can be used to create a ServerContext without the clientId
 */
export function extractContextFromToken(payload: TokenPayload): {
  userId: string;
  room: string;
} {
  return {
    userId: payload.userId,
    room: payload.room,
  };
}

/**
 * Utility function to check if a token has expired
 */
export function isTokenExpired(payload: TokenPayload): boolean {
  if (!payload.exp) {
    return false; // No expiration set
  }
  return Math.floor(Date.now() / 1000) > payload.exp;
}

/**
 * Builder pattern for constructing DocumentAccess[] arrays
 */
export class DocumentAccessBuilder {
  private accessList: DocumentAccess[] = [];

  /**
   * Allow access to documents matching the pattern with the given permissions
   */
  allow(pattern: string, permissions: Permission[]): this {
    this.accessList.push({ pattern, permissions });
    return this;
  }

  /**
   * Deny access to documents matching the pattern (exclusion pattern)
   */
  deny(pattern: string): this {
    this.accessList.push({
      pattern: `!${pattern}`,
      permissions: ["read", "write", "comment", "suggest", "admin"],
    });
    return this;
  }

  /**
   * Allow all documents with the given permissions
   */
  allowAll(
    permissions: Permission[] = ["read", "write", "comment", "suggest"],
  ): this {
    return this.allow("*", permissions);
  }

  /**
   * Allow read-only access to documents matching the pattern
   */
  readOnly(pattern: string): this {
    return this.allow(pattern, ["read"]);
  }

  /**
   * Allow read and write access to documents matching the pattern
   */
  write(pattern: string): this {
    return this.allow(pattern, ["read", "write"]);
  }

  /**
   * Allow full access (all permissions) to documents matching the pattern
   */
  fullAccess(pattern: string): this {
    return this.allow(pattern, ["read", "write", "comment", "suggest"]);
  }

  /**
   * Allow admin access to documents matching the pattern
   */
  admin(pattern: string): this {
    return this.allow(pattern, ["admin"]);
  }

  /**
   * Allow comment access to documents matching the pattern
   */
  commentOnly(pattern: string): this {
    return this.allow(pattern, ["read", "comment"]);
  }

  /**
   * Allow suggest access to documents matching the pattern
   */
  suggestOnly(pattern: string): this {
    return this.allow(pattern, ["read", "comment", "suggest"]);
  }

  /**
   * Allow user to own all their documents (pattern: userId/*)
   */
  ownDocuments(
    userId: string,
    permissions: Permission[] = [
      "read",
      "write",
      "comment",
      "suggest",
      "admin",
    ],
  ): this {
    return this.allow(`${userId}/*`, permissions);
  }

  /**
   * Deny access to specific document
   */
  denyDocument(documentName: string): this {
    return this.deny(documentName);
  }

  /**
   * Return the constructed DocumentAccess[] array
   */
  build(): DocumentAccess[] {
    return this.accessList;
  }
}
