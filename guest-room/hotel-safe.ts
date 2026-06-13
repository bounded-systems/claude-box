/**
 * hotel-safe.ts — two-key encrypted storage (like a hotel safe deposit box).
 *
 * A hotel safe requires TWO keys to open:
 *   1. The hotel key (held by room-service, persists)
 *   2. The guest key (injected at launch, ephemeral)
 *
 * Neither key alone is sufficient. This provides defense in depth:
 *   - Compromised room-service without guest key → useless
 *   - Stolen guest key without room-service → useless
 *   - Both must be present at the moment of use
 *
 * Use cases:
 *   - Guest key comes from user at launch (typed or from hardware token)
 *   - Guest key comes from HSM/KMS at runtime
 *   - Guest key is derived from launch attestation
 *
 * The secret is encrypted as: E(E(secret, key1), key2)
 * Decryption requires both keys in sequence.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// ── Key types ───────────────────────────────────────────────────────────────

/** The hotel's key — held by room-service, persists across launches */
export type HotelKey = Buffer; // 32 bytes

/** The guest's key — injected at launch, ephemeral */
export type GuestKey = Buffer; // 32 bytes

/** A value encrypted with both keys */
export type LockedValue = Buffer;

// ── Two-key encryption ──────────────────────────────────────────────────────

/**
 * Encrypt a value with a single key (inner layer).
 */
function encryptLayer(value: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

/**
 * Decrypt a value with a single key (one layer).
 */
function decryptLayer(encrypted: Buffer, key: Buffer): Buffer {
  const iv = encrypted.subarray(0, IV_LENGTH);
  const tag = encrypted.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Lock a value with both keys: E(E(secret, hotelKey), guestKey)
 * Both keys required to unlock.
 */
export function lock(value: Buffer, hotelKey: HotelKey, guestKey: GuestKey): LockedValue {
  const inner = encryptLayer(value, hotelKey);
  return encryptLayer(inner, guestKey);
}

/**
 * Unlock a value with both keys.
 * Throws if either key is wrong.
 */
export function unlock(locked: LockedValue, hotelKey: HotelKey, guestKey: GuestKey): Buffer {
  const inner = decryptLayer(locked, guestKey);
  return decryptLayer(inner, hotelKey);
}

// ── Key derivation ──────────────────────────────────────────────────────────

/**
 * Derive a key from a passphrase + salt.
 * Use for guest keys derived from user input.
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  const hash = createHash("sha256");
  hash.update(salt);
  hash.update(passphrase);
  return hash.digest();
}

/**
 * Generate a random key (32 bytes).
 */
export function generateKey(): Buffer {
  return randomBytes(32);
}

// ── Hotel Safe ──────────────────────────────────────────────────────────────

/**
 * A hotel safe: a directory of two-key-encrypted values.
 *
 * The hotel key is held by the safe (room-service).
 * The guest key must be provided for each open operation.
 *
 * @example
 *   // At setup (with both keys):
 *   const safe = new HotelSafe("/room/safe", hotelKey);
 *   safe.deposit("signing-key", signingKeyBytes, guestKey);
 *
 *   // At runtime (room-service has hotelKey, launch provides guestKey):
 *   const signingKey = safe.open("signing-key", guestKey);
 */
export class HotelSafe {
  constructor(
    private readonly dir: string,
    private readonly hotelKey: HotelKey,
  ) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** Path to a locked value */
  private path(name: string): string {
    return join(this.dir, `${name}.locked`);
  }

  /**
   * Deposit a value into the safe (requires both keys).
   * The value is encrypted with both keys.
   */
  deposit(name: string, value: Buffer, guestKey: GuestKey): void {
    const locked = lock(value, this.hotelKey, guestKey);
    writeFileSync(this.path(name), locked, { mode: 0o600 });
  }

  /**
   * Open a value from the safe (requires the guest key).
   * The hotel key is already held by the safe.
   */
  open(name: string, guestKey: GuestKey): Buffer {
    const path = this.path(name);
    if (!existsSync(path)) {
      throw new Error(`value not found: ${name}`);
    }
    const locked = readFileSync(path);
    return unlock(locked, this.hotelKey, guestKey);
  }

  /** Check if a value exists in the safe */
  has(name: string): boolean {
    return existsSync(this.path(name));
  }

  /**
   * Use a value without exposing it (callback pattern).
   * The value is decrypted, used, then discarded.
   */
  async useValue<T>(
    name: string,
    guestKey: GuestKey,
    operation: (value: Buffer) => T | Promise<T>,
  ): Promise<T> {
    const value = this.open(name, guestKey);
    try {
      return await operation(value);
    } finally {
      // In a real implementation, we'd zero the buffer here
      // Node.js doesn't support secure memory wiping directly
    }
  }
}

// ── Key rotation ────────────────────────────────────────────────────────────

/**
 * Re-encrypt a locked value with a new guest key.
 * Requires both the old guest key (to unlock) and new guest key (to re-lock).
 */
export function rotateGuestKey(
  locked: LockedValue,
  hotelKey: HotelKey,
  oldGuestKey: GuestKey,
  newGuestKey: GuestKey,
): LockedValue {
  const value = unlock(locked, hotelKey, oldGuestKey);
  return lock(value, hotelKey, newGuestKey);
}

/**
 * Re-encrypt a locked value with a new hotel key.
 * Requires the guest key and both hotel keys.
 */
export function rotateHotelKey(
  locked: LockedValue,
  oldHotelKey: HotelKey,
  newHotelKey: HotelKey,
  guestKey: GuestKey,
): LockedValue {
  const value = unlock(locked, oldHotelKey, guestKey);
  return lock(value, newHotelKey, guestKey);
}
