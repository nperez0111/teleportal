import "@blocknote/mantine/style.css";
import { YTransport } from "match-maker";
import {
  exportEncryptionKey,
  importEncryptionKey,
} from "match-maker/encryption-key";
import { withEncryption } from "match-maker/transports";
import { useEffect, useState } from "react";

/**
 * Wraps a transport with encryption secured by the provided key
 * @param key - The encryption key to use
 */
export function getEncryptedTransport(key: CryptoKey) {
  return ({
    getDefaultTransport,
  }: {
    getDefaultTransport: () => YTransport<any, any>;
  }) => withEncryption(getDefaultTransport(), { key });
}

/**
 * React hook to manage an encryption key and its string representation
 * @param providedKey - Optional initial CryptoKey to use
 * @returns Object containing:
 *  - key: The current CryptoKey or null
 *  - keyString: String representation of the current key
 *  - setKey: Function to update the key from a string
 */
export function useEncryptionKey(providedKey?: CryptoKey) {
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [keyString, setKeyString] = useState<string>("");

  useEffect(() => {
    async function initializeKey() {
      if (providedKey) {
        setKey(providedKey);
        const exported = await exportEncryptionKey(providedKey);
        setKeyString(exported);
      }
    }
    initializeKey();
  }, [providedKey]);

  const setNewKey = async (newKeyString: string) => {
    try {
      const newKey = await importEncryptionKey(newKeyString);
      setKey(newKey);
      setKeyString(newKeyString);
    } catch (error) {
      console.error("Failed to import key:", error);
    }
  };

  return {
    key,
    keyString,
    setKey: setNewKey,
  };
}

/**
 * React hook that manages an encryption key stored in the URL hash
 * Extends useEncryptionKey to automatically sync the key with the URL
 * @returns Object containing:
 *  - key: The current CryptoKey or null
 *  - keyString: String representation of the current key
 *  - setKey: Function to update both the key and URL hash
 */
export function useEncryptionKeyFromUrl() {
  const baseKey = useEncryptionKey();

  useEffect(() => {
    async function initializeFromUrl() {
      const hash = window.location.hash;
      const tokenMatch = hash.match(/token=([^&]+)/);

      if (tokenMatch) {
        try {
          await baseKey.setKey(tokenMatch[1]);
        } catch (error) {
          console.error("Failed to import key from URL:", error);
        }
      }
    }

    initializeFromUrl();
  }, []);

  const setNewKey = async (newKeyString: string) => {
    await baseKey.setKey(newKeyString);
    window.location.hash = `token=${newKeyString}`;
  };

  return {
    ...baseKey,
    setKey: setNewKey,
  };
}
