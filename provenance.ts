#!/usr/bin/env bun
/**
 * provenance.ts — emit the L1 image-provenance attestation for the box image.
 *
 * Produces a `CapabilityProvenance/v0.1` in-toto Statement (see contract/) for
 * the built OCI image:
 *   - subject      = the image digest
 *   - producer     = the nix flake rev (the build is a pinned, reproducible
 *                    dockerTools.buildLayeredImage — hermetic by construction)
 *   - materials    = the pinned inputs: nixpkgs (flake.lock) + the prx release
 *   - capabilities = EMPTY — a freshly built image holds no granted doors;
 *                    authority is only ever added at launch (L2). This is the
 *                    honest baseline surface: "config volume only, nothing
 *                    ambient."
 *
 * The statement is written to stdout (sign it downstream, e.g. `cosign
 * attest`). The image digest is supplied by the caller (it only exists after
 * `nix build` + load):
 *
 *   nix run .#provenance -- --image-digest sha256:<hex>
 *   # or derive it:  --image-digest "$(skopeo inspect ... | jq -r .Digest)"
 */

import { statement, type CapabilityProvenanceStatement, type Material } from "./contract/types.ts";

const DEFAULT_IMAGE = "claude-personal:dev";

type Opts = {
  root?: string; // flake dir (default ".")
  imageDigest: string; // "sha256:<hex>" or "<hex>"
  imageName?: string;
  flakeRev?: string; // default: git HEAD of root
  now?: string;
};

/** sha256:<hex> | <hex> -> 64-char lowercase hex (validated). */
function sha256Hex(s: string): string {
  const hex = s.replace(/^sha256:/, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new Error(`image digest is not a sha256 hex: "${s}"`);
  }
  return hex;
}

async function gitHead(root: string): Promise<string> {
  const p = Bun.spawn(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  return out;
}

/** Pinned inputs that determine the image: nixpkgs (flake.lock) + prx (flake.nix). */
async function materials(root: string): Promise<Material[]> {
  const out: Material[] = [];

  const lock = JSON.parse(await Bun.file(`${root}/flake.lock`).text());
  const nixpkgs = lock?.nodes?.nixpkgs?.locked;
  if (nixpkgs?.rev) {
    out.push({
      uri: `github:${nixpkgs.owner}/${nixpkgs.repo}/${nixpkgs.rev}`,
      // rev is a git commit (sha1), narHash an SRI string — neither is a
      // sha256-hex, so carry them under explicit non-"sha256" keys.
      digest: { gitCommit: nixpkgs.rev, ...(nixpkgs.narHash ? { narHash: nixpkgs.narHash } : {}) },
    });
  }

  // prx is a fetchurl pin in flake.nix (not a flake input): url + nix-SRI sha256.
  const flake = await Bun.file(`${root}/flake.nix`).text();
  const prx = flake.match(/fetchurl\s*{[^}]*?url\s*=\s*"([^"]+)"[^}]*?sha256\s*=\s*"([^"]+)"/s);
  if (prx) {
    out.push({ uri: prx[1]!, digest: { nixHash: `sha256:${prx[2]!}` } });
  }

  return out;
}

export async function buildImageProvenance(opts: Opts): Promise<CapabilityProvenanceStatement> {
  const root = opts.root ?? ".";
  const rev = opts.flakeRev ?? (await gitHead(root));
  const name = opts.imageName ?? DEFAULT_IMAGE;
  return statement(
    [{ name, digest: { sha256: sha256Hex(opts.imageDigest) } }],
    {
      level: "image",
      producer: { kind: "nix-flake", id: rev ? `git+rev:${rev}` : "git+rev:unknown" },
      image: { name, digest: { sha256: sha256Hex(opts.imageDigest) } },
      capabilities: { workcell: "claude-box", doors: [], denied: [] }, // none at build
      materials: await materials(root),
      metadata: { finishedOn: opts.now ?? new Date().toISOString() },
    },
  );
}

async function main(argv: string[]): Promise<number> {
  let imageDigest: string | undefined;
  let imageName: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--image-digest") imageDigest = argv[++i];
    else if (argv[i] === "--image-name") imageName = argv[++i];
    else if (argv[i] === "--root") root = argv[++i];
  }
  if (!imageDigest) {
    console.error("usage: provenance --image-digest sha256:<hex> [--image-name NAME] [--root DIR]");
    return 2;
  }
  const stmt = await buildImageProvenance({ imageDigest, imageName, root });
  console.log(JSON.stringify(stmt, null, 2));
  return 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
