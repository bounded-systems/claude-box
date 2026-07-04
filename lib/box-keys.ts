/**
 * box-keys — claude-box's own local grant-signing key.
 *
 * Every gated tcp door must always verify a signed grant — no per-door
 * opt-out (this session's explicit call: "always require a grant, even if
 * it's simple; harden it later"). The concierge-issued, room-registered
 * grant model isn't wired into claude-box.ts's direct CLI launch path yet
 * (that's launcherd.ts's daemon-mediated path only), so standing up a full
 * concierge round-trip for every direct launch is a bigger job than one
 * door's wiring. This is the deliberately simple stand-in: ONE static
 * ed25519 keypair, generated once and persisted under
 * $XDG_CONFIG_HOME/claude-box, that claude-box.ts signs grants with and a
 * door daemon (authd today) verifies against — no concierge dependency, no
 * rotation, no per-launch audience registration. Real hardening (rotation,
 * concierge-backed issuance, per-room audiences) is future work; the
 * invariant that must hold from day one is "a grant is always required and
 * always actually verified," which this satisfies.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, sign as nodeSign, createPrivateKey } from "node:crypto";
import type { IssuerKeys } from "../guest-room/mod.ts";

const KEY_ID = "box-1";

function keyDir(): string {
  return `${process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`}/claude-box`;
}
function privKeyPath(): string {
  return `${keyDir()}/issuer.key.pem`;
}
/** The public half, published in the IssuerKeys shape a door's verifier reads
 *  directly (see authd.ts's AUTHD_ISSUER_KEYS_PATH). */
function pubKeyPath(): string {
  return `${keyDir()}/issuer.pub.json`;
}

export type BoxKey = {
  keyId: string;
  sign: (data: string) => string;
  publicKeyPem: string;
};

/** Load claude-box's local signing key, generating and persisting it on
 *  first use. Every launch that mints a grant reuses the SAME key, so an
 *  authd (or other door) seeded with the published public key can keep
 *  verifying across restarts without a re-exchange. */
export function loadOrCreateBoxKey(): BoxKey {
  const dir = keyDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  let privateKeyPem: string;
  let publicKeyPem: string;
  if (existsSync(privKeyPath()) && existsSync(pubKeyPath())) {
    privateKeyPem = readFileSync(privKeyPath(), "utf-8");
    const issuerKeys = JSON.parse(readFileSync(pubKeyPath(), "utf-8")) as IssuerKeys;
    publicKeyPem = issuerKeys.keys[0]!.publicKeyPem;
  } else {
    const kp = generateKeyPairSync("ed25519");
    privateKeyPem = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    publicKeyPem = kp.publicKey.export({ type: "spki", format: "pem" }) as string;
    writeFileSync(privKeyPath(), privateKeyPem, { mode: 0o600 });
    const issuerKeys: IssuerKeys = { keys: [{ kid: KEY_ID, publicKeyPem }] };
    writeFileSync(pubKeyPath(), JSON.stringify(issuerKeys, null, 2));
  }

  const privateKey = createPrivateKey(privateKeyPem);
  return {
    keyId: KEY_ID,
    sign: (data: string) => nodeSign(null, Buffer.from(data), privateKey).toString("base64"),
    publicKeyPem,
  };
}

/** Where the published public key lives — pass this to a door daemon (e.g.
 *  `AUTHD_ISSUER_KEYS_PATH=$(claude-box issuer-keys-path)`) so it can verify
 *  grants this process mints without a concierge round-trip. */
export function issuerKeysPath(): string {
  return pubKeyPath();
}
