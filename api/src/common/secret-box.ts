import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * Encrypts small values (registry passwords) with a key derived from the server secret. AES-256-GCM, so a
 * tampered or wrong-key value fails to open instead of returning garbage. `purpose` separates uses of one secret.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string, purpose: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'provelox', purpose, 32));
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }

  /** The original value, or null when it was tampered with or sealed with another secret. */
  open(sealed: string): string | null {
    try {
      const buf = Buffer.from(sealed, 'base64url');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        buf.subarray(0, 12),
      );
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([
        decipher.update(buf.subarray(28)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}
