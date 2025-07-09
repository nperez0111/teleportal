import {
  compose,
  sync,
  type YSink,
  type YSource,
  type YTransport,
} from "teleportal";
import {
  createDecryptionTransform,
  createEncryptionTransform,
  type EncryptedClientContext,
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
  transport: YTransport<Context, AdditionalProperties>,
  options: { 
    key: CryptoKey; 
    document: string;
    encryptedClientContext?: EncryptedClientContext;
  },
): YTransport<Context, AdditionalProperties & { 
  key: CryptoKey;
  encryptedClientContext?: EncryptedClientContext;
}> {
  const reader = createDecryptionTransform<Context>(
    options.key,
    options.document,
    options.encryptedClientContext,
  );
  const writer = createEncryptionTransform<Context>(
    options.key,
    options.encryptedClientContext,
  );

  const decryptedSource: YSource<Context, any> = {
    readable: reader.readable,
  };
  const encryptedSink: YSink<Context, any> = {
    writable: writer.writable,
  };
  const encryptedTransport = compose(decryptedSource, encryptedSink);

  sync(encryptedTransport, transport);

  return {
    ...transport,
    key: options.key,
    encryptedClientContext: options.encryptedClientContext,
    readable: writer.readable,
    writable: reader.writable,
  };
}
