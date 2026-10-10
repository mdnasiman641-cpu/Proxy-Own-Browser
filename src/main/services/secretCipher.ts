/**
 * Encrypts proxy passwords before they are written to the database.
 * The Electron implementation (OS-level DPAPI on Windows) lives in electronCipher.ts.
 */
export interface SecretCipher {
  /** True when secrets are protected by the operating system rather than just encoded. */
  readonly isSecure: boolean
  encrypt(plain: string): string
  /** Throws if the value cannot be decrypted (e.g. database copied from another PC/user). */
  decrypt(stored: string): string
}

/**
 * Fallback/testing cipher. Only base64-encodes — used when OS encryption is unavailable,
 * which the Settings page reports to the user.
 */
export class EncodingOnlyCipher implements SecretCipher {
  readonly isSecure = false

  encrypt(plain: string): string {
    return `plain:v1:${Buffer.from(plain, 'utf8').toString('base64')}`
  }

  decrypt(stored: string): string {
    if (!stored.startsWith('plain:v1:')) throw new Error('Unsupported secret format')
    return Buffer.from(stored.slice('plain:v1:'.length), 'base64').toString('utf8')
  }
}
