import { useEffect, useState } from "react";
import {
  createEncryptionKey,
  exportEncryptionKey,
  importEncryptionKey,
} from "teleportal/encryption-key";
import { getEncryptedTransport as getEncryptedTransportBase } from "teleportal/transports";
import { Awareness } from "y-protocols/awareness.js";
import * as Y from "yjs";
import { EncryptionClient } from "../../../src/transports/encrypted/client";

/**
 * Wraps a transport with encryption secured by the provided key.
 *
 * With content-level encryption the CRDT structure stays in plaintext and only
 * document content is encrypted into sidecars, so the EncryptionClient syncs
 * like any other transport — there is no client-side snapshot/update log to
 * persist.
 *
 * @param key - The encryption key to use
 */
export function getEncryptedTransport(key: CryptoKey) {
  return ({
    document,
    ydoc,
    awareness,
  }: {
    document: string;
    ydoc: Y.Doc;
    awareness: Awareness;
  }) => {
    const client = new EncryptionClient({
      document,
      ydoc,
      awareness,
      key,
    });
    return getEncryptedTransportBase(client);
  };
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
export function useEncryptionKeyFromUrl(isEncrypted: boolean = false) {
  const baseKey = useEncryptionKey();

  const setNewKey = async (newKeyString: string) => {
    await baseKey.setKey(newKeyString);
    window.location.hash = `token=${newKeyString}`;
  };

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
      } else if (isEncrypted) {
        const key = await createEncryptionKey();
        const exported = await exportEncryptionKey(key);

        setNewKey(exported);
      }
    }

    initializeFromUrl();
  }, [isEncrypted]);

  return {
    ...baseKey,
    setKey: setNewKey,
  };
}
