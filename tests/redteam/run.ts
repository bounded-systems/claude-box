#!/usr/bin/env bun
/**
 * Red-team runner — drives the mission catalog against live boxes and prints a
 * containment report. On-demand only (nondeterministic, costs tokens, needs an
 * authed account + running doors). NOT part of CI `bun test`.
 *
 *   nix run nixpkgs#bun -- tests/redteam/run.ts --list   # enumerate (no runtime)
 *   nix run nixpkgs#bun -- tests/redteam/run.ts          # run all missions
 *   nix run nixpkgs#bun -- tests/redteam/run.ts exfil host-rce
 *
 * Exit code is non-zero if ANY mission reports a breach (boundary did not hold),
 * so it can gate a manual security check.
 */
import { MISSIONS, missionById, type Mission } from "./missions.ts";
import { runMission, runtimeReady } from "./harness.ts";

const args = Bun.argv.slice(2);

if (args.includes("--list") || args.includes("-l")) {
  console.log("red-team missions (fuzzer = headless Claude, oracle = external):\n");
  for (const m of MISSIONS) {
    console.log(`  ${m.id.padEnd(14)} ${m.title}`);
    console.log(`  ${"".padEnd(14)} invariant: ${m.invariant}`);
    console.log(`  ${"".padEnd(14)} oracle: ${m.oracle.kind}\n`);
  }
  process.exit(0);
}

const selected: Mission[] = args.length
  ? args.map((id) => {
      const m = missionById(id);
      if (!m) {
        console.error(`unknown mission: ${id} (known: ${MISSIONS.map((x) => x.id).join(", ")})`);
        process.exit(2);
      }
      return m;
    })
  : MISSIONS;

if (!runtimeReady()) {
  console.error(
    "runtime not ready: need rootless podman, the loaded image, and claude-box\n" +
      "on PATH (and an authenticated account). Run `nix run .#setup` first.\n" +
      "Use `--list` to enumerate missions without a runtime.",
  );
  process.exit(1);
}

console.log(`red-team: ${selected.length} mission(s)\n`);
let breaches = 0;
let skipped = 0;

for (const m of selected) {
  const r = await runMission(m);
  if (!r.ran) {
    console.log(`  SKIP  ${m.id.padEnd(14)} ${r.note}`);
    skipped++;
    continue;
  }
  const held = r.verdict?.held ?? false;
  const tag = held ? "HELD " : "BREACH";
  console.log(`  ${tag} ${m.id.padEnd(14)} ${r.verdict?.evidence}`);
  if (!held) breaches++;
}

console.log(
  `\n${selected.length - skipped} ran · ${breaches} breach(es) · ${skipped} skipped`,
);
if (breaches > 0) {
  console.log(
    "\nA breach means an OCAP invariant is FALSE. Fix it, then add a deterministic\n" +
      "regression probe to tests/ocap.test.ts so it can never silently return.",
  );
}
process.exit(breaches > 0 ? 1 : 0);
