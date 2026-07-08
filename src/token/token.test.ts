import { describe, expect, it, beforeEach } from "bun:test";
import {
  createTokenManager,
  type TokenPayload,
  DocumentAccessBuilder,
  isTokenExpired,
  extractContextFromToken,
} from "./index";

describe("TokenManager", () => {
  let tokenManager: ReturnType<typeof createTokenManager>;

  beforeEach(() => {
    tokenManager = createTokenManager({
      secret: "test-secret-key-for-testing-only",
      expiresIn: 3600,
      issuer: "test-issuer",
    });
  });

  describe("createAdminToken", () => {
    it("should create an admin token with full access", async () => {
      const token = await tokenManager.createAdminToken("admin-789", "org-456");

      const result = await tokenManager.verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.payload?.userId).toBe("admin-789");
      expect(result.payload?.room).toBe("org-456");
      expect(result.payload?.documentAccess).toHaveLength(1);
      expect(result.payload?.documentAccess![0].pattern).toBe("*");
      expect(result.payload?.documentAccess![0].permissions).toEqual(["admin"]);
    });
  });

  describe("createDocumentToken", () => {
    it("should create a token with specific document access", async () => {
      const token = await tokenManager.createToken("user-101", "org-456", [
        {
          pattern: "shared/*",
          permissions: ["read", "comment"],
        },
        {
          pattern: "projects/my-project/*",
          permissions: ["read", "write", "comment", "suggest"],
        },
      ]);

      const result = await tokenManager.verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.payload?.documentAccess).toHaveLength(2);
      expect(result.payload?.documentAccess![0].pattern).toBe("shared/*");
      expect(result.payload?.documentAccess![0].permissions).toEqual(["read", "comment"]);
      expect(result.payload?.documentAccess![1].pattern).toBe("projects/my-project/*");
      expect(result.payload?.documentAccess![1].permissions).toEqual([
        "read",
        "write",
        "comment",
        "suggest",
      ]);
    });
  });

  describe("verifyToken", () => {
    it("should verify a valid token", async () => {
      const token = await tokenManager.createAdminToken("user-123", "org-456");
      const result = await tokenManager.verifyToken(token);

      expect(result.valid).toBe(true);
      expect(result.payload).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it("should reject an invalid token", async () => {
      const result = await tokenManager.verifyToken("invalid-token");

      expect(result.valid).toBe(false);
      expect(result.payload).toBeUndefined();
      expect(result.error).toBeDefined();
    });

    it("should reject a token with wrong issuer", async () => {
      const wrongTokenManager = createTokenManager({
        secret: "test-secret-key-for-testing-only",
        issuer: "wrong-issuer",
      });

      const token = await tokenManager.createAdminToken("user-123", "org-456");
      const result = await wrongTokenManager.verifyToken(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should reject a token with wrong audience", async () => {
      const wrongTokenManager = createTokenManager({
        secret: "test-secret-key-for-testing-only",
        issuer: "test-issuer",
        audience: "wrong-audience",
      });

      const token = await tokenManager.createAdminToken("user-123", "org-456");
      const result = await wrongTokenManager.verifyToken(token);

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("hasDocumentPermission", () => {
    let payload: TokenPayload;

    beforeEach(async () => {
      const token = await tokenManager.createToken("user-101", "org-456", [
        {
          pattern: "shared/*",
          permissions: ["read", "comment"],
        },
        {
          pattern: "projects/my-project/*",
          permissions: ["read", "write", "comment", "suggest"],
        },
        {
          pattern: "user-101/*",
          permissions: ["read", "write", "comment", "suggest", "admin"],
        },
      ]);

      const result = await tokenManager.verifyToken(token);
      payload = result.payload!;
    });

    it("should check exact pattern matches", () => {
      expect(tokenManager.hasDocumentPermission(payload, "shared/doc1", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "shared/doc1", "write")).toBe(false);
    });

    it("should check prefix pattern matches", () => {
      expect(tokenManager.hasDocumentPermission(payload, "user-101/document1", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "user-101/document1", "write")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "user-101/document1", "admin")).toBe(true);
    });

    it("should check nested prefix pattern matches", () => {
      expect(tokenManager.hasDocumentPermission(payload, "projects/my-project/doc1", "read")).toBe(
        true,
      );
      expect(tokenManager.hasDocumentPermission(payload, "projects/my-project/doc1", "write")).toBe(
        true,
      );
      expect(tokenManager.hasDocumentPermission(payload, "projects/my-project/doc1", "admin")).toBe(
        false,
      );
    });

    it("should return false for non-matching patterns", () => {
      expect(tokenManager.hasDocumentPermission(payload, "other/doc1", "read")).toBe(false);
      expect(tokenManager.hasDocumentPermission(payload, "user-102/doc1", "read")).toBe(false);
    });

    it("should handle admin permission correctly", () => {
      expect(tokenManager.hasDocumentPermission(payload, "user-101/doc1", "admin")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "shared/doc1", "admin")).toBe(false);
    });
  });

  describe("getDocumentPermissions", () => {
    let payload: TokenPayload;

    beforeEach(async () => {
      const token = await tokenManager.createToken("user-101", "org-456", [
        {
          pattern: "shared/*",
          permissions: ["read", "comment"],
        },
        {
          pattern: "user-101/*",
          permissions: ["read", "write", "comment", "suggest", "admin"],
        },
      ]);

      const result = await tokenManager.verifyToken(token);
      payload = result.payload!;
    });

    it("should return permissions for matching documents", () => {
      const sharedPermissions = tokenManager.getDocumentPermissions(payload, "shared/doc1");
      expect(sharedPermissions).toEqual(["read", "comment"]);

      const userPermissions = tokenManager.getDocumentPermissions(payload, "user-101/doc1");
      expect(userPermissions).toEqual(["read", "write", "comment", "suggest", "admin"]);
    });

    it("should return empty array for non-matching documents", () => {
      const permissions = tokenManager.getDocumentPermissions(payload, "other/doc1");
      expect(permissions).toEqual([]);
    });
  });

  describe("pattern matching", () => {
    let payload: TokenPayload;

    beforeEach(async () => {
      const token = await tokenManager.createToken("user-101", "org-456", [
        {
          pattern: "doc1",
          permissions: ["read"],
        },
        {
          pattern: "user/*",
          permissions: ["read"],
        },
        {
          pattern: "org/project/*",
          permissions: ["read"],
        },
        {
          pattern: "*.md",
          permissions: ["read"],
        },
        {
          pattern: "user*",
          permissions: ["read"],
        },
      ]);

      const result = await tokenManager.verifyToken(token);
      payload = result.payload!;
    });

    it("should match exact patterns", () => {
      expect(tokenManager.hasDocumentPermission(payload, "doc1", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "doc2", "read")).toBe(false);
    });

    it("should match prefix patterns", () => {
      expect(tokenManager.hasDocumentPermission(payload, "user/doc1", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "user/doc2", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "user/project/doc3", "read")).toBe(true);
    });

    it("should match nested prefix patterns", () => {
      expect(tokenManager.hasDocumentPermission(payload, "org/project/doc1", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "org/project/doc2", "read")).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(payload, "org/project/subfolder/doc3", "read"),
      ).toBe(true);
    });

    it("should match suffix patterns", () => {
      expect(tokenManager.hasDocumentPermission(payload, "readme.md", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "document.md", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "document.txt", "read")).toBe(false);
    });

    it("should match prefix with wildcard patterns", () => {
      expect(tokenManager.hasDocumentPermission(payload, "user123", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "user456", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "other123", "read")).toBe(false);
    });
  });

  describe("exclusion patterns", () => {
    let payload: TokenPayload;

    beforeEach(async () => {
      const token = await tokenManager.createToken("user-101", "org-456", [
        {
          pattern: "*",
          permissions: ["read"],
        },
        {
          pattern: "!private/*",
          permissions: ["read"],
        },
        {
          pattern: "!*.secret",
          permissions: ["read"],
        },
        {
          pattern: "!admin-doc",
          permissions: ["read"],
        },
        {
          pattern: "!user/admin/*",
          permissions: ["read"],
        },
      ]);

      const result = await tokenManager.verifyToken(token);
      payload = result.payload!;
    });

    it("should exclude exact document names", () => {
      expect(tokenManager.hasDocumentPermission(payload, "admin-doc", "read")).toBe(false);
      expect(tokenManager.hasDocumentPermission(payload, "other-doc", "read")).toBe(true);
    });

    it("should exclude prefix patterns", () => {
      expect(tokenManager.hasDocumentPermission(payload, "private/doc1", "read")).toBe(false);
      expect(tokenManager.hasDocumentPermission(payload, "private/doc2", "read")).toBe(false);
      expect(tokenManager.hasDocumentPermission(payload, "public/doc1", "read")).toBe(true);
    });

    it("should exclude suffix patterns", () => {
      expect(tokenManager.hasDocumentPermission(payload, "config.secret", "read")).toBe(false);
      expect(tokenManager.hasDocumentPermission(payload, "config.public", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "readme.secret", "read")).toBe(false);
    });

    it("should exclude nested prefix patterns", () => {
      expect(tokenManager.hasDocumentPermission(payload, "user/admin/doc1", "read")).toBe(false);
      expect(tokenManager.hasDocumentPermission(payload, "user/admin/doc2", "read")).toBe(false);
      expect(tokenManager.hasDocumentPermission(payload, "user/public/doc1", "read")).toBe(true);
    });

    it("should work with complex exclusion patterns", () => {
      // Test that exclusions work with wildcard base patterns
      expect(tokenManager.hasDocumentPermission(payload, "any-document", "read")).toBe(true);
      expect(tokenManager.hasDocumentPermission(payload, "private/any-document", "read")).toBe(
        false,
      );
      expect(tokenManager.hasDocumentPermission(payload, "document.secret", "read")).toBe(false);
    });
  });

  describe("token expiration", () => {
    it("sets exp on minted tokens and verifies while unexpired", async () => {
      const token = await tokenManager.generateToken(
        "user-123",
        "org-456",
        [{ pattern: "*", permissions: ["read"] }],
        { expiresIn: 3600 },
      );
      const result = await tokenManager.verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.payload?.exp).toBeDefined();
    });

    it("rejects an already-expired token (no sleeping — exp set in the past)", async () => {
      // Mint a token whose exp is already in the past via jose directly, so the
      // test is instant and event-free rather than waiting on a real timeout.
      const { SignJWT } = await import("jose");
      const secret = new TextEncoder().encode("test-secret-key-for-testing-only");
      const past = Math.floor(Date.now() / 1000) - 60;
      const token = await new SignJWT({ userId: "u", room: "r" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(past - 60)
        .setExpirationTime(past)
        .setIssuer("test-issuer")
        .setAudience("teleportal")
        .sign(secret);

      const result = await tokenManager.verifyToken(token);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      // jose surfaces expiry with an "exp" mention in the message.
      expect(result.error).toContain("exp");
    });
  });

  describe("custom options", () => {
    it("should respect custom issuer and audience", async () => {
      const customTokenManager = createTokenManager({
        secret: "test-secret-key-for-testing-only",
        issuer: "custom-issuer",
      });

      const token = await customTokenManager.generateToken("user-123", "org-456", [
        { pattern: "*", permissions: ["read"] },
      ]);

      const result = await customTokenManager.verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.payload?.iss).toBe("custom-issuer");
      expect(result.payload?.aud).toBe("teleportal");
    });

    it("should verify a token minted with a custom audience", async () => {
      const customTokenManager = createTokenManager({
        secret: "test-secret-key-for-testing-only",
        audience: "custom-audience",
      });

      const token = await customTokenManager.generateToken("user-123", "org-456", [
        { pattern: "*", permissions: ["read"] },
      ]);

      const result = await customTokenManager.verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.payload?.aud).toBe("custom-audience");
    });

    it("should reject a token whose audience does not match the manager", async () => {
      const issuer = createTokenManager({
        secret: "test-secret-key-for-testing-only",
      });
      const verifier = createTokenManager({
        secret: "test-secret-key-for-testing-only",
        audience: "other-service",
      });

      const token = await issuer.generateToken("user-123", "org-456", [
        { pattern: "*", permissions: ["read"] },
      ]);

      const result = await verifier.verifyToken(token);
      expect(result.valid).toBe(false);
    });
  });

  describe("getDocumentPermissions aggregation", () => {
    it("should aggregate permissions across multiple matching patterns", async () => {
      const token = await tokenManager.createToken("user-101", "org-456", [
        { pattern: "shared/*", permissions: ["read"] },
        { pattern: "*", permissions: ["comment"] },
      ]);

      const result = await tokenManager.verifyToken(token);
      const permissions = tokenManager.getDocumentPermissions(result.payload!, "shared/doc1");
      expect(permissions).toContain("read");
      expect(permissions).toContain("comment");
    });

    it("should return empty array for excluded documents", async () => {
      const token = await tokenManager.createToken("user-101", "org-456", [
        { pattern: "*", permissions: ["read", "write"] },
        { pattern: "!secret/*", permissions: ["read", "write"] },
      ]);

      const result = await tokenManager.verifyToken(token);
      expect(tokenManager.getDocumentPermissions(result.payload!, "secret/doc1")).toEqual([]);
      expect(tokenManager.getDocumentPermissions(result.payload!, "public/doc1")).toEqual([
        "read",
        "write",
      ]);
    });

    it("should deduplicate permissions from overlapping patterns", async () => {
      const token = await tokenManager.createToken("user-101", "org-456", [
        { pattern: "user-101/*", permissions: ["read", "write"] },
        { pattern: "*", permissions: ["read"] },
      ]);

      const result = await tokenManager.verifyToken(token);
      const permissions = tokenManager.getDocumentPermissions(result.payload!, "user-101/doc1");
      const readCount = permissions.filter((p) => p === "read").length;
      expect(readCount).toBe(1);
    });
  });

  describe("audience parameter", () => {
    it("should use the default 'teleportal' audience", async () => {
      const token = await tokenManager.generateToken("user-123", "org-456", [
        { pattern: "*", permissions: ["read"] },
      ]);

      const result = await tokenManager.verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.payload?.aud).toBe("teleportal");
    });

    it("should embed a custom audience in the token payload", async () => {
      const token = await tokenManager.generateToken(
        "user-123",
        "org-456",
        [{ pattern: "*", permissions: ["read"] }],
        { audience: "custom-audience" },
      );

      // Token has the custom audience but this verifier expects "teleportal",
      // so verification should fail (audience mismatch).
      const result = await tokenManager.verifyToken(token);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("aud");
    });
  });

  describe("no documentAccess", () => {
    it("hasDocumentPermission returns true when documentAccess is undefined", () => {
      const payload: TokenPayload = {
        userId: "user-1",
        room: "room-1",
      };
      expect(tokenManager.hasDocumentPermission(payload, "any-doc", "read")).toBe(true);
    });

    it("getDocumentPermissions returns empty when documentAccess is undefined", () => {
      const payload: TokenPayload = {
        userId: "user-1",
        room: "room-1",
      };
      expect(tokenManager.getDocumentPermissions(payload, "any-doc")).toEqual([]);
    });

    it("documents the fail-open/fail-closed asymmetry for a missing policy", () => {
      // SECURITY CONTRACT (see README gotcha #1): a token with no documentAccess
      // grants ALL permissions via hasDocumentPermission (fail-open) but yields
      // NO permissions via getDocumentPermissions (fail-closed). This asymmetry
      // is intentional; changing it is a deliberate security decision.
      const payload: TokenPayload = { userId: "user-1", room: "room-1" };
      for (const perm of ["read", "write", "comment", "suggest", "admin"] as const) {
        expect(tokenManager.hasDocumentPermission(payload, "any-doc", perm)).toBe(true);
      }
      expect(tokenManager.getDocumentPermissions(payload, "any-doc")).toEqual([]);
    });

    it("hasDocumentPermission ignores payload.room (caller must check it)", () => {
      // The permission check is document-scoped only; room enforcement is the
      // caller's responsibility (see check-permission.ts).
      const payload: TokenPayload = {
        userId: "user-1",
        room: "room-1",
        documentAccess: [{ pattern: "*", permissions: ["read"] }],
      };
      expect(tokenManager.hasDocumentPermission(payload, "doc-in-any-room", "read")).toBe(true);
    });
  });

  describe("DocumentAccessBuilder", () => {
    it("should build basic access patterns", () => {
      const access = new DocumentAccessBuilder()
        .allow("user/*", ["read", "write"])
        .deny("private/*")
        .build();

      expect(access).toHaveLength(2);
      expect(access[0]).toEqual({
        pattern: "user/*",
        permissions: ["read", "write"],
      });
      expect(access[1]).toEqual({
        pattern: "!private/*",
        permissions: ["read", "write", "comment", "suggest", "admin"],
      });
    });

    it("should use convenience methods", () => {
      const access = new DocumentAccessBuilder()
        .readOnly("public/*")
        .write("user/*")
        .fullAccess("admin/*")
        .admin("super-admin/*")
        .build();

      expect(access).toHaveLength(4);
      expect(access[0]).toEqual({ pattern: "public/*", permissions: ["read"] });
      expect(access[1]).toEqual({
        pattern: "user/*",
        permissions: ["read", "write"],
      });
      expect(access[2]).toEqual({
        pattern: "admin/*",
        permissions: ["read", "write", "comment", "suggest"],
      });
      expect(access[3]).toEqual({
        pattern: "super-admin/*",
        permissions: ["admin"],
      });
    });

    it("should use domain-specific methods", () => {
      const access = new DocumentAccessBuilder().ownDocuments("user-123").build();

      expect(access).toHaveLength(1);
      expect(access[0]).toEqual({
        pattern: "user-123/*",
        permissions: ["read", "write", "comment", "suggest", "admin"],
      });
    });

    it("should use denial convenience methods", () => {
      const access = new DocumentAccessBuilder().allowAll().denyDocument("config.json").build();

      expect(access).toHaveLength(2);
      expect(access[0]).toEqual({
        pattern: "*",
        permissions: ["read", "write", "comment", "suggest"],
      });
      expect(access[1]).toEqual({
        pattern: "!config.json",
        permissions: ["read", "write", "comment", "suggest", "admin"],
      });
    });

    it("should work with custom permissions", () => {
      const access = new DocumentAccessBuilder()
        .ownDocuments("user-123", ["read", "write"])
        .build();

      expect(access).toHaveLength(1);
      expect(access[0]).toEqual({
        pattern: "user-123/*",
        permissions: ["read", "write"],
      });
    });

    it("should create complex access patterns", () => {
      const access = new DocumentAccessBuilder()
        .allowAll(["read", "write"])
        .ownDocuments("user-456", ["read", "write", "comment", "suggest", "admin"])
        .admin("system/*")
        .build();

      expect(access).toHaveLength(3);

      // Verify the patterns are in the expected order
      expect(access[0].pattern).toBe("*");
      expect(access[1].pattern).toBe("user-456/*");
      expect(access[2].pattern).toBe("system/*");
    });
  });

  describe("utility functions", () => {
    it("isTokenExpired returns false when no exp is set", () => {
      expect(isTokenExpired({ userId: "u", room: "r" })).toBe(false);
    });

    it("isTokenExpired returns false for a future exp", () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      expect(isTokenExpired({ userId: "u", room: "r", exp: future })).toBe(false);
    });

    it("isTokenExpired returns true for a past exp", () => {
      const past = Math.floor(Date.now() / 1000) - 10;
      expect(isTokenExpired({ userId: "u", room: "r", exp: past })).toBe(true);
    });

    it("extractContextFromToken extracts userId and room", () => {
      const ctx = extractContextFromToken({ userId: "alice", room: "room-1" });
      expect(ctx).toEqual({ userId: "alice", room: "room-1" });
    });
  });

  describe("token signing security", () => {
    it("should reject a token signed with a different secret", async () => {
      const other = createTokenManager({
        secret: "totally-different-secret-key",
        issuer: "test-issuer",
      });
      const token = await other.createAdminToken("user-1", "room-1");
      const result = await tokenManager.verifyToken(token);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should reject a tampered token", async () => {
      const token = await tokenManager.createAdminToken("user-1", "room-1");
      const parts = token.split(".");
      const payload = JSON.parse(atob(parts[1]));
      payload.userId = "evil-user";
      parts[1] = btoa(JSON.stringify(payload));
      const tampered = parts.join(".");
      const result = await tokenManager.verifyToken(tampered);
      expect(result.valid).toBe(false);
    });

    it("should only accept HS256, rejecting other HMAC algorithms (alg pinning)", async () => {
      // A token minted with HS512 against the same secret must NOT verify, because
      // the manager pins the accepted algorithm to HS256. Without pinning, jose
      // would accept any HMAC algorithm the symmetric key supports.
      const { SignJWT } = await import("jose");
      const secret = new TextEncoder().encode("test-secret-key-for-testing-only");
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ userId: "u", room: "r" })
        .setProtectedHeader({ alg: "HS512" })
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .setIssuer("test-issuer")
        .setAudience("teleportal")
        .sign(secret);

      const result = await tokenManager.verifyToken(token);
      expect(result.valid).toBe(false);
    });
  });

  describe("pattern matching regex-metacharacter safety", () => {
    // Wildcard patterns are compiled to a RegExp internally. Every character
    // other than `*` must be treated LITERALLY; otherwise a pattern (which may
    // originate from a document name or an exclusion rule) can inject regex
    // syntax and either over-match (grant unintended access) or under-match
    // (fail to exclude a document it was meant to deny).

    async function payloadFor(pattern: string) {
      const token = await tokenManager.createToken("u", "r", [{ pattern, permissions: ["read"] }]);
      const result = await tokenManager.verifyToken(token);
      return result.payload!;
    }

    it("treats parentheses/alternation as literal, not a regex group", async () => {
      const payload = await payloadFor("a(b|c)*");
      // Should ONLY match strings beginning with the literal "a(b|c)".
      expect(tokenManager.hasDocumentPermission(payload, "a(b|c)xyz", "read")).toBe(true);
      // These must NOT match — "(b|c)" is not an alternation.
      expect(tokenManager.hasDocumentPermission(payload, "ab", "read")).toBe(false);
      expect(tokenManager.hasDocumentPermission(payload, "ac", "read")).toBe(false);
    });

    it("treats character classes as literal, not a regex class", async () => {
      const payload = await payloadFor("doc[1]*");
      // Should ONLY match strings beginning with the literal "doc[1]".
      expect(tokenManager.hasDocumentPermission(payload, "doc[1]file", "read")).toBe(true);
      // Must NOT match — "[1]" is not a character class selecting "1".
      expect(tokenManager.hasDocumentPermission(payload, "doc1file", "read")).toBe(false);
    });

    it("does not let regex metacharacters weaken an exclusion rule", async () => {
      const token = await tokenManager.createToken("u", "r", [
        { pattern: "*", permissions: ["read"] },
        // Intended to exclude documents literally named like "logs[prod]/*"
        { pattern: "!logs[prod]*", permissions: ["read"] },
      ]);
      const payload = (await tokenManager.verifyToken(token)).payload!;

      // The literal document the rule targets must be excluded.
      expect(tokenManager.hasDocumentPermission(payload, "logs[prod]/2024", "read")).toBe(false);
      // A document that only matches if "[prod]" is a regex class must NOT be
      // accidentally excluded (proves the class is literal, not interpreted).
      expect(tokenManager.hasDocumentPermission(payload, "logsp/2024", "read")).toBe(true);
    });

    it("treats other metacharacters (+, ?, backslash, anchors) literally", async () => {
      const payload = await payloadFor("a+b*");
      expect(tokenManager.hasDocumentPermission(payload, "a+bc", "read")).toBe(true);
      // "aaab" would match if "+" meant one-or-more "a".
      expect(tokenManager.hasDocumentPermission(payload, "aaab", "read")).toBe(false);
    });
  });
});
