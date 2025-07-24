import { type Sink, type Source, type Transport } from "teleportal";
import { sync, compose } from "teleportal/transports";
import {
  createDecryptionTransform,
  createEncryptionTransform,
} from "teleportal/protocol/encryption";

/**
 * Reads encrypted messages and decodes them into regular messages.
 * @deprecated Use the protocol-level encryption functions instead.
 */
export function getMessageDecryptor<
  Context extends Record<string, unknown>,
>(options: { key: CryptoKey; document: string }) {
  return createDecryptionTransform<Context>(options.key, options.document);
}

/**
 * Encrypts messages using the protocol-level encryption.
 * @deprecated Use the protocol-level encryption functions instead.
 */
export function getMessageEncryptor<
  Context extends Record<string, unknown>,
>(options: { key: CryptoKey }) {
  return createEncryptionTransform<Context>(options.key);
}

/**
 * Wraps a transport in encryption, encrypting all document messages that are sent through the transport.
 */
export function withEncryption<
  Context extends Record<string, unknown>,
  AdditionalProperties extends Record<string, unknown>,
>(
  transport: Transport<Context, AdditionalProperties>,
  options: { key: CryptoKey; document: string },
): Transport<Context, AdditionalProperties & { key: CryptoKey }> {
  const reader = createDecryptionTransform<Context>(
    options.key,
    options.document,
  );
  const writer = createEncryptionTransform<Context>(options.key);

  const decryptedSource: Source<Context> = {
    readable: reader.readable,
  };
  const encryptedSink: Sink<Context> = {
    writable: writer.writable,
  };
  const encryptedTransport = compose(decryptedSource, encryptedSink);

  sync(encryptedTransport, transport);

  return {
    ...transport,
    key: options.key,
    readable: writer.readable,
    writable: reader.writable,
  };
}
