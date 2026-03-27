import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";

const ALG = "aes-256-gcm";
const SALT = "omni-chat-field-enc-v1";

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SALT, 32) as Buffer;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns an empty string when plaintext or secret is empty.
 * The returned ciphertext is a JSON-encoded envelope safe to store in a DB field.
 */
export function encryptField(plaintext: string, secret: string): string {
  if (!plaintext || !secret) return "";
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}

/**
 * Decrypt a value previously produced by encryptField.
 * Returns an empty string on any failure (wrong key, tampered data, empty input).
 */
export function decryptField(ciphertext: string, secret: string): string {
  if (!ciphertext || !secret) return "";
  try {
    const parsed = JSON.parse(ciphertext) as {
      v?: number;
      iv: string;
      tag: string;
      data: string;
    };
    const key = deriveKey(secret);
    const decipher = createDecipheriv(
      ALG,
      key,
      Buffer.from(parsed.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    return (
      decipher.update(Buffer.from(parsed.data, "base64")).toString("utf8") +
      decipher.final("utf8")
    );
  } catch {
    return "";
  }
}
