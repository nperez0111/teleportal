import { createEncryptionKey } from "../../encryption-key";
import type { Message } from "../message-types";
import { encryptMessage, decryptMessage } from "./index";

/**
 * High-level utility functions for protocol-level encryption
 */

/**
 * Creates a new encryption key for protocol-level encryption
 */
export async function createProtocolEncryptionKey(): Promise<CryptoKey> {
  return await createEncryptionKey();
}

/**
 * Simple encrypt function that wraps protocol-level encryption
 */
export async function encrypt<Context extends Record<string, unknown>>(
  message: Message<Context>,
  key: CryptoKey,
): Promise<Message<Context>> {
  return await encryptMessage(message, key);
}

/**
 * Simple decrypt function that wraps protocol-level decryption
 */
export async function decrypt<Context extends Record<string, unknown>>(
  message: Message<Context>,
  key: CryptoKey,
  documentName: string,
): Promise<Message<Context>> {
  return await decryptMessage(message, key, documentName);
}

/**
 * Batch encrypt multiple messages
 */
export async function encryptBatch<Context extends Record<string, unknown>>(
  messages: Message<Context>[],
  key: CryptoKey,
): Promise<Message<Context>[]> {
  return await Promise.all(
    messages.map(message => encryptMessage(message, key))
  );
}

/**
 * Batch decrypt multiple messages
 */
export async function decryptBatch<Context extends Record<string, unknown>>(
  messages: Message<Context>[],
  key: CryptoKey,
  documentName: string,
): Promise<Message<Context>[]> {
  return await Promise.all(
    messages.map(message => decryptMessage(message, key, documentName))
  );
}

/**
 * Check if encryption is supported in the current environment
 */
export function isEncryptionSupported(): boolean {
  return typeof crypto !== 'undefined' && 
         typeof crypto.subtle !== 'undefined' &&
         typeof crypto.subtle.encrypt === 'function' &&
         typeof crypto.subtle.decrypt === 'function';
}

/**
 * Validate that a key is suitable for protocol encryption
 */
export function validateEncryptionKey(key: CryptoKey): boolean {
  return key.algorithm.name === 'AES-GCM' &&
         key.usages.includes('encrypt') &&
         key.usages.includes('decrypt');
}