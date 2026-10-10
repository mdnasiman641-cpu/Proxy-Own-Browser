import { safeStorage } from 'electron'
import { EncodingOnlyCipher, type SecretCipher } from '../services/secretCipher'

const PREFIX = 'enc:v1:'

/**
 * Uses Electron safeStorage (Windows DPAPI, tied to the current Windows user).
 * Falls back to encoding-only storage when OS encryption is unavailable.
 */
export class ElectronSafeStorageCipher implements SecretCipher {
  private readonly fallback = new EncodingOnlyCipher()

  get isSecure(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  encrypt(plain: string): string {
    if (!this.isSecure) return this.fallback.encrypt(plain)
    return PREFIX + safeStorage.encryptString(plain).toString('base64')
  }

  decrypt(stored: string): string {
    if (stored.startsWith(PREFIX)) {
      return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'))
    }
    return this.fallback.decrypt(stored)
  }
}
