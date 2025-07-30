// import { describe, expect, it, beforeEach } from "bun:test";
// import { DocMessage, AwarenessMessage } from "../message-types";
// import { createEncryptionKey } from "../../../encryption-key";
// import {
//   encryptMessage,
//   decryptMessage,
//   createEncryptionTransform,
//   createDecryptionTransform,
// } from "./index.ts.bak";
// import type {
//   Update,
//   StateVector,
//   AwarenessUpdateMessage,
//   SyncStep2Update,
// } from "../types";

// // Helper function to create a proper Update type
// function createUpdate(data: Uint8Array): Update {
//   return data as Update;
// }

// // Helper function to create a proper StateVector type
// function createStateVector(data: Uint8Array): StateVector {
//   return data as StateVector;
// }

// // Helper function to create a proper AwarenessUpdateMessage type
// function createAwarenessUpdate(data: Uint8Array): AwarenessUpdateMessage {
//   return data as AwarenessUpdateMessage;
// }

// describe("protocol encryption", () => {
//   let key1: CryptoKey;
//   let key2: CryptoKey;

//   beforeEach(async () => {
//     key1 = await createEncryptionKey();
//     key2 = await createEncryptionKey();
//   });

//   describe("encryptMessage", () => {
//     it("should encrypt doc update messages", async () => {
//       const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));
//       const message = new DocMessage(
//         "test-doc",
//         { type: "update", update: testUpdate },
//         { clientId: "test" },
//         false,
//       );

//       const encrypted = await encryptMessage(message, key1);

//       expect(encrypted.encrypted).toBe(true);
//       expect(encrypted.type).toBe("doc");
//       expect(encrypted.document).toBe("test-doc");
//       expect(encrypted.context.clientId).toBe("test");
//       expect(encrypted.payload.type).toBe("update");

//       // The update should be different (encrypted)
//       if (encrypted.payload.type === "update") {
//         expect(encrypted.payload.update).not.toEqual(testUpdate);
//       }
//     });

//     it("should encrypt doc sync-step-2 messages", async () => {
//       const testUpdate = new Uint8Array([1, 2, 3, 4, 5]) as SyncStep2Update;
//       const message = new DocMessage(
//         "test-doc",
//         { type: "sync-step-2", update: testUpdate },
//         { clientId: "test" },
//         false,
//       );

//       const encrypted = await encryptMessage(message, key1);

//       expect(encrypted.encrypted).toBe(true);
//       expect(encrypted.payload.type).toBe("sync-step-2");

//       // The update should be different (encrypted)
//       if (encrypted.payload.type === "sync-step-2") {
//         expect(encrypted.payload.update).not.toEqual(testUpdate);
//       }
//     });

//     it("should handle sync-step-1 messages", async () => {
//       const testStateVector = createStateVector(new Uint8Array([1, 2, 3]));
//       const message = new DocMessage(
//         "test-doc",
//         { type: "sync-step-1", sv: testStateVector },
//         { clientId: "test" },
//         false,
//       );

//       const encrypted = await encryptMessage(message, key1);

//       expect(encrypted.encrypted).toBe(true);
//       expect(encrypted.payload.type).toBe("sync-step-1");

//       // The state vector should be different (faux)
//       if (encrypted.payload.type === "sync-step-1") {
//         expect(encrypted.payload.sv).not.toEqual(testStateVector);
//       }
//     });

//     it("should pass through auth messages", async () => {
//       const message = new DocMessage(
//         "test-doc",
//         { type: "auth-message", permission: "denied", reason: "test" },
//         { clientId: "test" },
//         false,
//       );

//       const encrypted = await encryptMessage(message, key1);

//       expect(encrypted.encrypted).toBe(true);
//       expect(encrypted.payload.type).toBe("auth-message");

//       // Auth messages should be passed through unchanged
//       if (encrypted.payload.type === "auth-message") {
//         expect(encrypted.payload.permission).toBe("denied");
//         expect(encrypted.payload.reason).toBe("test");
//       }
//     });

//     it("should pass through awareness messages", async () => {
//       const awarenessUpdate = createAwarenessUpdate(
//         new Uint8Array([1, 2, 3, 4, 5]),
//       );
//       const message = new AwarenessMessage(
//         "test-doc",
//         { type: "awareness-update", update: awarenessUpdate },
//         { clientId: "test" },
//         false,
//       );

//       const encrypted = await encryptMessage(message, key1);

//       expect(encrypted.encrypted).toBe(true);
//       expect(encrypted.type).toBe("awareness");

//       // Awareness messages should be passed through unchanged
//       if (
//         encrypted.type === "awareness" &&
//         encrypted.payload.type === "awareness-update"
//       ) {
//         expect(encrypted.payload.update).toEqual(awarenessUpdate);
//       }
//     });
//   });

//   describe("decryptMessage", () => {
//     it("should decrypt doc update messages", async () => {
//       const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));
//       const message = new DocMessage(
//         "test-doc",
//         { type: "update", update: testUpdate },
//         { clientId: "test" },
//         false,
//       );

//       const encrypted = await encryptMessage(message, key1);
//       const decrypted = await decryptMessage(encrypted, key1);

//       expect(decrypted.encrypted).toBe(false);
//       expect(decrypted.type).toBe("doc");
//       expect(decrypted.document).toBe("test-doc");
//       expect(decrypted.context.clientId).toBe("test");
//       expect(decrypted.payload.type).toBe("update");

//       // The update should be restored to original
//       if (decrypted.payload.type === "update") {
//         expect(decrypted.payload.update).toEqual(testUpdate);
//       }
//     });

//     it("should decrypt doc sync-step-2 messages", async () => {
//       const testUpdate = new Uint8Array([1, 2, 3, 4, 5]) as SyncStep2Update;
//       const message = new DocMessage(
//         "test-doc",
//         { type: "sync-step-2", update: testUpdate },
//         { clientId: "test" },
//         false,
//       );

//       const encrypted = await encryptMessage(message, key1);
//       const decrypted = await decryptMessage(encrypted, key1);

//       expect(decrypted.encrypted).toBe(false);
//       expect(decrypted.payload.type).toBe("sync-step-2");

//       // The update should be restored to original
//       if (decrypted.payload.type === "sync-step-2") {
//         expect(decrypted.payload.update).toEqual(testUpdate);
//       }
//     });

//     it("should fail to decrypt with wrong key", async () => {
//       const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));
//       const message = new DocMessage(
//         "test-doc",
//         { type: "update", update: testUpdate },
//         { clientId: "test" },
//         false,
//       );

//       const encrypted = await encryptMessage(message, key1);

//       await expect(decryptMessage(encrypted, key2)).rejects.toThrow();
//     });

//     it("should handle awareness messages", async () => {
//       const awarenessUpdate = createAwarenessUpdate(
//         new Uint8Array([1, 2, 3, 4, 5]),
//       );
//       const message = new AwarenessMessage(
//         "test-doc",
//         { type: "awareness-update", update: awarenessUpdate },
//         { clientId: "test" },
//         false,
//       );

//       const encrypted = await encryptMessage(message, key1);
//       const decrypted = await decryptMessage(encrypted, key1);

//       expect(decrypted.encrypted).toBe(false);
//       expect(decrypted.type).toBe("awareness");

//       // Awareness messages should be passed through unchanged
//       if (
//         decrypted.type === "awareness" &&
//         decrypted.payload.type === "awareness-update"
//       ) {
//         expect(decrypted.payload.update).toEqual(awarenessUpdate);
//       }
//     });
//   });

//   describe("transform streams", () => {
//     it("should create encryption transform stream", async () => {
//       const encryptionTransform = createEncryptionTransform(key1);

//       expect(encryptionTransform).toBeDefined();
//       expect(encryptionTransform.readable).toBeDefined();
//       expect(encryptionTransform.writable).toBeDefined();
//     });

//     it("should create decryption transform stream", async () => {
//       const decryptionTransform = createDecryptionTransform(key1, "test-doc");

//       expect(decryptionTransform).toBeDefined();
//       expect(decryptionTransform.readable).toBeDefined();
//       expect(decryptionTransform.writable).toBeDefined();
//     });

//     it("should handle individual encrypt/decrypt operations", async () => {
//       const testUpdate = createUpdate(new Uint8Array([1, 2, 3, 4, 5]));
//       const message = new DocMessage(
//         "test-doc",
//         { type: "update", update: testUpdate },
//         { clientId: "test" },
//         false,
//       );

//       // Test encryption
//       const encrypted = await encryptMessage(message, key1);
//       expect(encrypted.encrypted).toBe(true);

//       // Test decryption
//       const decrypted = await decryptMessage(encrypted, key1);
//       expect(decrypted.encrypted).toBe(false);

//       if (decrypted.payload.type === "update") {
//         expect(decrypted.payload.update).toEqual(testUpdate);
//       }
//     });
//   });
// });
