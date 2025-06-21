import { type Update } from "../lib";
export type EncryptedUpdate = Update;

export class UpdateEncryptionManager {
  private static encryptionKey: CryptoKey | null = null;
  private static keyPromise: Promise<CryptoKey> | null = null;
  private static readyPromise: Promise<void> | null = null;

  public static async ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = new Promise((resolve) => {
        const checkKey = () => {
          if (this.encryptionKey) {
            resolve();
          } else {
            setTimeout(checkKey, 100);
          }
        };
        checkKey();
      });
    }
    return this.readyPromise;
  }

  /**
   * Generate or retrieve the encryption key for AES-GCM
   */
  private static async getEncryptionKey(): Promise<CryptoKey> {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    if (this.keyPromise) {
      return this.keyPromise;
    }

    this.keyPromise = (async () => {
      try {
        // Generate a new AES-GCM key
        this.encryptionKey = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 }, // Use 256-bit key for better security
          true, // extractable
          ["encrypt", "decrypt"],
        );
        return this.encryptionKey;
      } catch (error) {
        this.keyPromise = null;
        throw new Error(`Failed to generate encryption key: ${error}`);
      }
    })();

    return this.keyPromise;
  }

  /**
   * Encrypt a Y.js update using AES-GCM
   * @param update - The update to encrypt
   * @returns The encrypted update as a Uint8Array
   */
  public static async encryptUpdate(update: Update): Promise<EncryptedUpdate> {
    try {
      const key = await this.getEncryptionKey();

      // Generate a random IV (Initialization Vector) for each encryption
      const iv = crypto.getRandomValues(new Uint8Array(12)); // 12 bytes for AES-GCM

      // Encrypt the update
      const encryptedData = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv,
        },
        key,
        update,
      );

      // Combine IV and encrypted data (which includes the authentication tag)
      const result = new Uint8Array(iv.length + encryptedData.byteLength);
      result.set(iv, 0);
      result.set(new Uint8Array(encryptedData), iv.length);

      return result as Update;
    } catch (error) {
      throw new Error(`Encryption failed: ${error}`);
    }
  }

  /**
   * Decrypt a Y.js update using AES-GCM
   * @param encryptedUpdate - The encrypted update to decrypt
   * @returns The decrypted update as a Uint8Array
   */
  public static async decryptUpdate(
    encryptedUpdate: EncryptedUpdate,
  ): Promise<Update> {
    try {
      const key = await this.getEncryptionKey();

      // Extract IV (first 12 bytes) and encrypted data (which includes auth tag)
      const iv = encryptedUpdate.slice(0, 12);
      const encryptedData = encryptedUpdate.slice(12);

      // Decrypt the data
      const decryptedData = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        encryptedData,
      );

      return new Uint8Array(decryptedData) as Update;
    } catch (error) {
      throw new Error(`Decryption failed: ${error}`);
    }
  }

  /**
   * Set a custom encryption key (useful for sharing keys between clients)
   * @param key - The raw key data as string
   */
  public static async setEncryptionKey(key: string): Promise<void> {
    console.log("Setting encryption key", key);
    try {
      this.encryptionKey = await crypto.subtle.importKey(
        "jwk",
        {
          k: key,
          alg: "A256GCM", // Use A256GCM to match the 256-bit key length
          ext: true,
          key_ops: ["encrypt", "decrypt"],
          kty: "oct",
        },
        { name: "AES-GCM", length: 256 },
        true, // extractable - keep consistent with generated keys
        ["encrypt", "decrypt"],
      );
      console.log("Encryption key set", this.encryptionKey);
      this.keyPromise = null;
    } catch (error) {
      throw new Error(`Failed to import encryption key: ${error}`);
    }
  }

  /**
   * Export the current encryption key for sharing
   * @returns The raw key data as string
   */
  public static async exportEncryptionKey(): Promise<string | undefined> {
    try {
      const key = await this.getEncryptionKey();
      const exported = await crypto.subtle.exportKey("jwk", key);
      return exported.k;
    } catch (error) {
      throw new Error(`Failed to export encryption key: ${error}`);
    }
  }

  /**
   * Reset the encryption manager (useful for testing or key rotation)
   */
  public static reset(): void {
    this.encryptionKey = null;
    this.keyPromise = null;
  }
}
