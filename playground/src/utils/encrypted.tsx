import { Transport } from "teleportal";
import {
  exportEncryptionKey,
  importEncryptionKey,
  createEncryptionKey,
} from "teleportal/encryption-key";
import { getEncryptedTransport as getEncryptedTransportBase } from "teleportal/transports";
import { useEffect, useState } from "react";
import { EncryptionClient } from "../../../src/transports/encrypted/client";
import { Awareness } from "y-protocols/awareness.js";
import * as Y from "yjs";
import { fromBase64, toBase64 } from "lib0/buffer";

/**
 * Wraps a transport with encryption secured by the provided key
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
    const prefix = "teleportal-encrypted-" + document;
    const client = new EncryptionClient({
      document,
      ydoc,
      awareness,
      key,
      getEncryptedMessageUpdate: async (messageId) => {
        const payload = localStorage.getItem(prefix + "-update-" + messageId);
        if (!payload) {
          throw new Error("Message not found");
        }
        return fromBase64(payload);
      },
    });
    // TODO more convenient way to do this
    client.on("seen-update", (update) => {
      localStorage.setItem(
        prefix + "-update-" + update.id,
        toBase64(update.payload),
      );
    });
    client.on("update-seen-messages", (seenMessages) => {
      localStorage.setItem(
        prefix + "-seen-messages",
        JSON.stringify(seenMessages),
      );
    });
    client.loadSeenMessages(
      JSON.parse(localStorage.getItem(prefix + "-seen-messages") ?? "{}"),
    );
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
