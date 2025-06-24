import { describe, expect, it, beforeEach } from "bun:test";
import {
  createTokenManager,
  type TokenPayload,
  DocumentAccessBuilder,
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
      expect(result.payload?.documentAccess[0].pattern).toBe("*");
      expect(result.payload?.documentAccess[0].permissions).toEqual(["admin"]);
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
      expect(result.payload?.documentAccess[0].pattern).toBe("shared/*");
      expect(result.payload?.documentAccess[0].permissions).toEqual([
        "read",
        "comment",
      ]);
      expect(result.payload?.documentAccess[1].pattern).toBe(
        "projects/my-project/*",
      );
      expect(result.payload?.documentAccess[1].permissions).toEqual([
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

    // it("should reject a token with wrong audience", async () => {
    //   const wrongTokenManager = createTokenManager({
    //     secret: "test-secret-key-for-testing-only",
    //     issuer: "test-issuer",
    //   });

    //   const token = await tokenManager.createAdminToken("user-123", "org-456");
    //   const result = await wrongTokenManager.verifyToken(token);

    //   expect(result.valid).toBe(false);
    //   expect(result.error).toBeDefined();
    // });
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
      expect(
        tokenManager.hasDocumentPermission(payload, "shared/doc1", "read"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(payload, "shared/doc1", "write"),
      ).toBe(false);
    });

    it("should check prefix pattern matches", () => {
      expect(
        tokenManager.hasDocumentPermission(
          payload,
          "user-101/document1",
          "read",
        ),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(
          payload,
          "user-101/document1",
          "write",
        ),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(
          payload,
          "user-101/document1",
          "admin",
        ),
      ).toBe(true);
    });

    it("should check nested prefix pattern matches", () => {
      expect(
        tokenManager.hasDocumentPermission(
          payload,
          "projects/my-project/doc1",
          "read",
        ),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(
          payload,
          "projects/my-project/doc1",
          "write",
        ),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(
          payload,
          "projects/my-project/doc1",
          "admin",
        ),
      ).toBe(false);
    });

    it("should return false for non-matching patterns", () => {
      expect(
        tokenManager.hasDocumentPermission(payload, "other/doc1", "read"),
      ).toBe(false);
      expect(
        tokenManager.hasDocumentPermission(payload, "user-102/doc1", "read"),
      ).toBe(false);
    });

    it("should handle admin permission correctly", () => {
      expect(
        tokenManager.hasDocumentPermission(payload, "user-101/doc1", "admin"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(payload, "shared/doc1", "admin"),
      ).toBe(false);
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
      const sharedPermissions = tokenManager.getDocumentPermissions(
        payload,
        "shared/doc1",
      );
      expect(sharedPermissions).toEqual(["read", "comment"]);

      const userPermissions = tokenManager.getDocumentPermissions(
        payload,
        "user-101/doc1",
      );
      expect(userPermissions).toEqual([
        "read",
        "write",
        "comment",
        "suggest",
        "admin",
      ]);
    });

    it("should return empty array for non-matching documents", () => {
      const permissions = tokenManager.getDocumentPermissions(
        payload,
        "other/doc1",
      );
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
      expect(tokenManager.hasDocumentPermission(payload, "doc1", "read")).toBe(
        true,
      );
      expect(tokenManager.hasDocumentPermission(payload, "doc2", "read")).toBe(
        false,
      );
    });

    it("should match prefix patterns", () => {
      expect(
        tokenManager.hasDocumentPermission(payload, "user/doc1", "read"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(payload, "user/doc2", "read"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(
          payload,
          "user/project/doc3",
          "read",
        ),
      ).toBe(true);
    });

    it("should match nested prefix patterns", () => {
      expect(
        tokenManager.hasDocumentPermission(payload, "org/project/doc1", "read"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(payload, "org/project/doc2", "read"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(
          payload,
          "org/project/subfolder/doc3",
          "read",
        ),
      ).toBe(true);
    });

    it("should match suffix patterns", () => {
      expect(
        tokenManager.hasDocumentPermission(payload, "readme.md", "read"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(payload, "document.md", "read"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(payload, "document.txt", "read"),
      ).toBe(false);
    });

    it("should match prefix with wildcard patterns", () => {
      expect(
        tokenManager.hasDocumentPermission(payload, "user123", "read"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(payload, "user456", "read"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(payload, "other123", "read"),
      ).toBe(false);
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
      expect(
        tokenManager.hasDocumentPermission(payload, "admin-doc", "read"),
      ).toBe(false);
      expect(
        tokenManager.hasDocumentPermission(payload, "other-doc", "read"),
      ).toBe(true);
    });

    it("should exclude prefix patterns", () => {
      expect(
        tokenManager.hasDocumentPermission(payload, "private/doc1", "read"),
      ).toBe(false);
      expect(
        tokenManager.hasDocumentPermission(payload, "private/doc2", "read"),
      ).toBe(false);
      expect(
        tokenManager.hasDocumentPermission(payload, "public/doc1", "read"),
      ).toBe(true);
    });

    it("should exclude suffix patterns", () => {
      expect(
        tokenManager.hasDocumentPermission(payload, "config.secret", "read"),
      ).toBe(false);
      expect(
        tokenManager.hasDocumentPermission(payload, "config.public", "read"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(payload, "readme.secret", "read"),
      ).toBe(false);
    });

    it("should exclude nested prefix patterns", () => {
      expect(
        tokenManager.hasDocumentPermission(payload, "user/admin/doc1", "read"),
      ).toBe(false);
      expect(
        tokenManager.hasDocumentPermission(payload, "user/admin/doc2", "read"),
      ).toBe(false);
      expect(
        tokenManager.hasDocumentPermission(payload, "user/public/doc1", "read"),
      ).toBe(true);
    });

    it("should work with complex exclusion patterns", () => {
      // Test that exclusions work with wildcard base patterns
      expect(
        tokenManager.hasDocumentPermission(payload, "any-document", "read"),
      ).toBe(true);
      expect(
        tokenManager.hasDocumentPermission(
          payload,
          "private/any-document",
          "read",
        ),
      ).toBe(false);
      expect(
        tokenManager.hasDocumentPermission(payload, "document.secret", "read"),
      ).toBe(false);
    });
  });

  // describe("token expiration", () => {
  //   it("should create tokens with expiration", async () => {
  //     const token = await tokenManager.generateToken(
  //       "user-123",
  //       "org-456",
  //       [{ pattern: "*", permissions: ["read"] }],
  //       { expiresIn: 1 },
  //     ); // 1 second expiration

  //     const result = await tokenManager.verifyToken(token);
  //     expect(result.valid).toBe(true);
  //     expect(result.payload?.exp).toBeDefined();

  //     // Wait for token to expire
  //     await new Promise((resolve) => setTimeout(resolve, 1100));

  //     const expiredResult = await tokenManager.verifyToken(token);
  //     expect(expiredResult.valid).toBe(false);
  //     expect(expiredResult.error).toBeDefined();
  //   });
  // });

  describe("custom options", () => {
    it("should respect custom issuer and audience", async () => {
      const customTokenManager = createTokenManager({
        secret: "test-secret-key-for-testing-only",
        issuer: "custom-issuer",
      });

      const token = await customTokenManager.generateToken(
        "user-123",
        "org-456",
        [{ pattern: "*", permissions: ["read"] }],
      );

      const result = await customTokenManager.verifyToken(token);
      expect(result.valid).toBe(true);
      expect(result.payload?.iss).toBe("custom-issuer");
      expect(result.payload?.aud).toBe("teleportal");
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
      const access = new DocumentAccessBuilder()
        .ownDocuments("user-123")
        .build();

      expect(access).toHaveLength(1);
      expect(access[0]).toEqual({
        pattern: "user-123/*",
        permissions: ["read", "write", "comment", "suggest", "admin"],
      });
    });

    it("should use denial convenience methods", () => {
      const access = new DocumentAccessBuilder()
        .allowAll()
        .denyDocument("config.json")
        .build();

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
        .ownDocuments("user-456", [
          "read",
          "write",
          "comment",
          "suggest",
          "admin",
        ])
        .admin("system/*")
        .build();

      expect(access).toHaveLength(3);

      // Verify the patterns are in the expected order
      expect(access[0].pattern).toBe("*");
      expect(access[1].pattern).toBe("user-456/*");
      expect(access[2].pattern).toBe("system/*");
    });
  });
});
