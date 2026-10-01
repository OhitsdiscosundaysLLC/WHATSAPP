import { randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptBuffer,
  decryptJson,
  encryptBuffer,
  encryptJson,
  parseEncryptionKey,
} from './encryption';

const VALID_KEY_HEX = randomBytes(32).toString('hex');

describe('parseEncryptionKey', () => {
  it('accepts a valid 64-char hex key and returns 32 bytes', () => {
    const key = parseEncryptionKey(VALID_KEY_HEX);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('throws when unset', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(/WHATSAPP_AUTH_ENCRYPTION_KEY is not set/);
  });

  it('throws when empty', () => {
    expect(() => parseEncryptionKey('')).toThrow();
  });

  it('throws when too short', () => {
    expect(() => parseEncryptionKey('abcd1234')).toThrow(/64 hex characters/);
  });

  it('throws when too long', () => {
    expect(() => parseEncryptionKey(VALID_KEY_HEX + 'ab')).toThrow(/64 hex characters/);
  });

  it('throws on non-hex characters', () => {
    expect(() => parseEncryptionKey('z'.repeat(64))).toThrow(/64 hex characters/);
  });

  it('tolerates surrounding whitespace', () => {
    expect(() => parseEncryptionKey(`  ${VALID_KEY_HEX}  `)).not.toThrow();
  });
});

describe('encryptBuffer / decryptBuffer', () => {
  const key = parseEncryptionKey(VALID_KEY_HEX);

  it('round-trips arbitrary binary data exactly', () => {
    const plaintext = randomBytes(256);
    const payload = encryptBuffer(plaintext, key);
    const decrypted = decryptBuffer(payload, key);
    expect(Buffer.compare(plaintext, decrypted)).toBe(0);
  });

  it('round-trips empty buffers', () => {
    const payload = encryptBuffer(Buffer.alloc(0), key);
    expect(decryptBuffer(payload, key).length).toBe(0);
  });

  it('uses a fresh random IV on every call (never reuses a nonce)', () => {
    const plaintext = Buffer.from('same plaintext every time');
    const a = encryptBuffer(plaintext, key);
    const b = encryptBuffer(plaintext, key);
    expect(Buffer.compare(a.iv, b.iv)).not.toBe(0);
    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0); // GCM: different IV -> different ciphertext
  });

  it('produces a 12-byte IV and a 16-byte auth tag', () => {
    const payload = encryptBuffer(Buffer.from('x'), key);
    expect(payload.iv.length).toBe(12);
    expect(payload.authTag.length).toBe(16);
  });

  it('fails to decrypt with the wrong key', () => {
    const payload = encryptBuffer(Buffer.from('secret'), key);
    const wrongKey = randomBytes(32);
    expect(() => decryptBuffer(payload, wrongKey)).toThrow();
  });

  it('fails to decrypt if the ciphertext was tampered with', () => {
    const payload = encryptBuffer(Buffer.from('secret'), key);
    payload.ciphertext[0] = (payload.ciphertext[0]! + 1) % 256;
    expect(() => decryptBuffer(payload, key)).toThrow();
  });

  it('fails to decrypt if the auth tag was tampered with', () => {
    const payload = encryptBuffer(Buffer.from('secret'), key);
    payload.authTag[0] = (payload.authTag[0]! + 1) % 256;
    expect(() => decryptBuffer(payload, key)).toThrow();
  });

  it('fails to decrypt if the IV is wrong', () => {
    const payload = encryptBuffer(Buffer.from('secret'), key);
    payload.iv = randomBytes(12);
    expect(() => decryptBuffer(payload, key)).toThrow();
  });
});

describe('encryptJson / decryptJson', () => {
  const key = parseEncryptionKey(VALID_KEY_HEX);

  it('round-trips a plain object', () => {
    const value = { a: 1, b: 'two', c: [1, 2, 3], d: { nested: true } };
    const payload = encryptJson(value, key);
    expect(decryptJson(payload, key)).toEqual(value);
  });

  it('round-trips Buffers via a custom replacer/reviver (BufferJSON-style)', () => {
    const replacer = (_k: string, v: unknown) =>
      Buffer.isBuffer(v) ? { type: 'Buffer', data: v.toString('base64') } : v;
    const reviver = (_k: string, v: unknown) => {
      if (v && typeof v === 'object' && (v as { type?: string }).type === 'Buffer') {
        return Buffer.from((v as { data: string }).data, 'base64');
      }
      return v;
    };

    const value = { key: Buffer.from('hello world'), n: 42 };
    const payload = encryptJson(value, key, replacer);
    const revived = decryptJson<typeof value>(payload, key, reviver);

    expect(Buffer.isBuffer(revived.key)).toBe(true);
    expect(Buffer.compare(revived.key, value.key)).toBe(0);
    expect(revived.n).toBe(42);
  });

  it('never leaks plaintext into the ciphertext bytes', () => {
    const secret = 'super-secret-whatsapp-credential-value';
    const payload = encryptJson({ secret }, key);
    expect(payload.ciphertext.toString('utf8')).not.toContain(secret);
    expect(payload.ciphertext.toString('base64')).not.toContain(secret);
  });
});
