/**
 * room-service.ts — the one service that holds secrets; everything else is a guest.
 *
 * In the strongest OCAP model, even daemons are guests. They don't hold secrets;
 * they hold doors to room-service, which issues ephemeral tokens for operations.
 *
 * The hierarchy:
 *   1. room-service: the ONLY thing with access to secrets (HSM, KMS, vault)
 *   2. daemons: guests with doors to room-service
 *   3. the box guest: guest with doors to daemons
 *
 * This is turtles all the way down: every layer is a guest asking through a door.
 * Secrets never leak because they never leave room-service.
 *
 * Token model:
 *   - JWT-like tokens with short expiry (default 60s)
 *   - Scoped to specific operation (e.g., "sign-commit", "fetch-repo")
 *   - Single-use via nonce tracking
 *   - Signed by room-service's key
 *
 * Vault integration is pluggable: consumers provide a VaultAdapter that
 * knows how to talk to their secret backend (HSM, KMS, HashiCorp Vault, etc.).
 *
 * This module is guest-agnostic: it provides the token mechanism, not the policy.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ── Token types ─────────────────────────────────────────────────────────────

export type TokenClaims = {
  /** Subject: what operation this token authorizes */
  sub: string;
  /** Issued at: Unix timestamp (seconds) */
  iat: number;
  /** Expires at: Unix timestamp (seconds) */
  exp: number;
  /** Nonce: unique per-token for single-use enforcement */
  nonce: string;
  /** Scope: additional restrictions (e.g., repo path, allowed hosts) */
  scope?: Record<string, unknown>;
};

export type Token = {
  claims: TokenClaims;
  signature: string;
};

// ── Token issuance (room-service side) ──────────────────────────────────────

/**
 * Issue an ephemeral token for a specific operation.
 *
 * @param signingKey - room-service's HMAC key (32 bytes)
 * @param subject - what operation this authorizes (e.g., "sign-commit")
 * @param ttlSeconds - how long until expiry (default 60)
 * @param scope - additional restrictions
 */
export function issueToken(
  signingKey: Buffer,
  subject: string,
  ttlSeconds: number = 60,
  scope?: Record<string, unknown>,
): Token {
  const now = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    sub: subject,
    iat: now,
    exp: now + ttlSeconds,
    nonce: randomBytes(16).toString("hex"),
    scope,
  };
  const payload = JSON.stringify(claims);
  const signature = createHmac("sha256", signingKey).update(payload).digest("hex");
  return { claims, signature };
}

/**
 * Serialize a token for transmission (e.g., in a request header).
 */
export function serializeToken(token: Token): string {
  const payload = Buffer.from(JSON.stringify(token.claims)).toString("base64url");
  return `${payload}.${token.signature}`;
}

/**
 * Deserialize a token from its string form.
 */
export function deserializeToken(tokenString: string): Token {
  const [payloadB64, signature] = tokenString.split(".");
  if (!payloadB64 || !signature) {
    throw new Error("invalid token format");
  }
  const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as TokenClaims;
  return { claims, signature };
}

// ── Token verification (daemon/guest side) ──────────────────────────────────

/**
 * Verify a token's signature and expiry.
 *
 * @param token - the token to verify
 * @param signingKey - room-service's HMAC key (must match issuer)
 * @returns the claims if valid
 * @throws if signature invalid, expired, or malformed
 */
export function verifyToken(token: Token, signingKey: Buffer): TokenClaims {
  // Verify signature
  const payload = JSON.stringify(token.claims);
  const expectedSig = createHmac("sha256", signingKey).update(payload).digest("hex");
  const actualSig = Buffer.from(token.signature, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");

  if (actualSig.length !== expectedBuf.length || !timingSafeEqual(actualSig, expectedBuf)) {
    throw new Error("invalid token signature");
  }

  // Verify expiry
  const now = Math.floor(Date.now() / 1000);
  if (token.claims.exp < now) {
    throw new Error("token expired");
  }

  return token.claims;
}

// ── Nonce tracking (single-use enforcement) ─────────────────────────────────

/**
 * A nonce store for single-use token enforcement.
 * Tracks used nonces and rejects replay attempts.
 */
export class NonceStore {
  private used = new Map<string, number>(); // nonce → expiry time
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(cleanupIntervalMs: number = 60_000) {
    // Periodically clean up expired nonces
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
  }

  /**
   * Check if a nonce is valid (not already used) and mark it as used.
   * @returns true if valid and now marked, false if already used
   */
  use(nonce: string, expiresAt: number): boolean {
    if (this.used.has(nonce)) {
      return false; // Already used
    }
    this.used.set(nonce, expiresAt);
    return true;
  }

  /** Clean up expired nonces */
  private cleanup(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [nonce, exp] of this.used) {
      if (exp < now) {
        this.used.delete(nonce);
      }
    }
  }

  /** Stop the cleanup interval */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Verify a token AND enforce single-use via nonce tracking.
 */
export function verifyTokenOnce(
  token: Token,
  signingKey: Buffer,
  nonceStore: NonceStore,
): TokenClaims {
  const claims = verifyToken(token, signingKey);

  if (!nonceStore.use(claims.nonce, claims.exp)) {
    throw new Error("token already used (replay detected)");
  }

  return claims;
}

// ── Vault adapter (pluggable secret backend) ────────────────────────────────

/**
 * A vault adapter knows how to use secrets without exposing them.
 * The secret NEVER leaves the vault; operations happen inside.
 */
export interface VaultAdapter {
  /**
   * Use a secret to perform an operation. The secret never leaves the vault.
   * The operation function receives the secret, uses it, and returns a result.
   * The secret is not returned — only the result.
   */
  useSecret<T>(
    name: string,
    operation: (secret: Buffer) => T | Promise<T>,
  ): Promise<T>;

  /** Check if a secret exists */
  has(name: string): Promise<boolean>;
}

/**
 * A simple in-memory vault for testing (NOT for production).
 * In production, use HSM, KMS, or a secrets manager.
 */
export class MemoryVault implements VaultAdapter {
  private secrets = new Map<string, Buffer>();

  /** Add a secret (setup time only) */
  set(name: string, secret: Buffer): void {
    this.secrets.set(name, Buffer.from(secret)); // Copy to prevent external mutation
  }

  async useSecret<T>(
    name: string,
    operation: (secret: Buffer) => T | Promise<T>,
  ): Promise<T> {
    const secret = this.secrets.get(name);
    if (!secret) throw new Error(`secret not found: ${name}`);
    return operation(secret);
  }

  async has(name: string): Promise<boolean> {
    return this.secrets.has(name);
  }
}

// ── Room Service ────────────────────────────────────────────────────────────

/**
 * The room-service: issues tokens and performs operations using vault secrets.
 *
 * @example
 *   const vault = new MemoryVault();
 *   vault.set("signing-key", signingKeyBytes);
 *
 *   const service = new RoomService(vault, hmacKey);
 *
 *   // Daemon requests a token to sign
 *   const token = service.issueToken("sign", { repo: "/work" });
 *
 *   // Daemon uses token to request signing
 *   const sig = await service.signWithToken(token, dataToSign);
 */
export class RoomService {
  private nonceStore = new NonceStore();

  constructor(
    private readonly vault: VaultAdapter,
    private readonly signingKey: Buffer, // For token signing, not for operations
  ) {}

  /** Issue a token for an operation */
  issueToken(subject: string, scope?: Record<string, unknown>, ttl?: number): Token {
    return issueToken(this.signingKey, subject, ttl, scope);
  }

  /** Verify a token (checks signature, expiry, and single-use) */
  verifyToken(token: Token): TokenClaims {
    return verifyTokenOnce(token, this.signingKey, this.nonceStore);
  }

  /** Use a secret from the vault (secret never leaves) */
  async useSecret<T>(
    name: string,
    operation: (secret: Buffer) => T | Promise<T>,
  ): Promise<T> {
    return this.vault.useSecret(name, operation);
  }

  /** Stop background cleanup */
  stop(): void {
    this.nonceStore.stop();
  }
}
