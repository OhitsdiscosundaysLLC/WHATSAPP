import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // recommended GCM nonce size

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Parses and validates `WHATSAPP_AUTH_ENCRYPTION_KEY`. Expected format:
 * exactly 64 hex characters (32 bytes / AES-256). Throws a precise,
 * actionable error rather than silently accepting a weak/malformed key —
 * this key protects every WhatsApp account's credentials, so a quiet
 * fallback here would be the wrong failure mode.
 *
 * Generate one with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
 * or `openssl rand -hex 32`.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      'WHATSAPP_AUTH_ENCRYPTION_KEY is not set. Generate one with: ' + `openssl rand -hex 32`,
    );
  }
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      'WHATSAPP_AUTH_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes / AES-256). ' +
        'Generate one with: openssl rand -hex 32',
    );
  }
  const key = Buffer.from(trimmed, 'hex');
  if (key.length !== KEY_BYTES) {
    // Unreachable given the regex above, but fail loudly rather than
    // silently proceeding with a wrong-length key if that ever changes.
    throw new Error(
      `WHATSAPP_AUTH_ENCRYPTION_KEY decoded to ${key.length} bytes, expected ${KEY_BYTES}`,
    );
  }
  return key;
}

/** AES-256-GCM encrypt. A fresh random IV is generated for every call — never reuse an IV with the same key. */
export function encryptBuffer(plaintext: Buffer, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/**
 * AES-256-GCM decrypt. Throws if the auth tag doesn't verify — a wrong
 * key, corrupted data, or tampering all surface as the same decryption
 * failure; callers must treat that as "this record cannot be trusted",
 * never fall back to a blank/default value (see docs/SECURITY.md).
 */
export function decryptBuffer(payload: EncryptedPayload, key: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

export function encryptJson(
  value: unknown,
  key: Buffer,
  replacer?: (key: string, value: unknown) => unknown,
): EncryptedPayload {
  const json = JSON.stringify(value, replacer);
  return encryptBuffer(Buffer.from(json, 'utf8'), key);
}

export function decryptJson<T>(
  payload: EncryptedPayload,
  key: Buffer,
  reviver?: (key: string, value: unknown) => unknown,
): T {
  const json = decryptBuffer(payload, key).toString('utf8');
  return JSON.parse(json, reviver) as T;
}
