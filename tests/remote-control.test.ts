/**
 * --remote-control profile tests (prx-9s14 / prx-z4c6) — pure unit tests over the
 * launcher. They assert the opt-in profile relaxes exactly two box defaults, and
 * ONLY for this launch:
 *   1. omits the inference-only CLAUDE_CODE_OAUTH_TOKEN (so a full-scope in-box
 *      `claude auth login`, persisted in the config volume, drives Remote
 *      Control — RC rejects inference-only tokens, and the env token would
 *      otherwise win per the auth precedence table), and
 *   2. unsets the image-baked CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC so the RC
 *      feature-flag gate (tengu_ccr_bridge, via GrowthBook) can evaluate.
 * The default box posture must be byte-for-byte unchanged. No podman needed.
 *
 *   nix run nixpkgs#bun -- test tests/remote-control.test.ts
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planLaunch,
  authEnvArgs,
  buildManifest,
  capabilityPrompt,
  capabilityMemoryCmd,
  buildRemoteServeScript,
  RC_WORKSPACE,
  remoteServeArgs,
  rcEgressAllow,
  RC_NETD_ALLOW,
  bastionName,
  bastionAlreadyRunning,
  authLeaseFromEnvCmd,
  cmdMintAuthGrant,
  cmdPrintRcBootScript,
} from "../claude-box.ts";

const EMPTY = { HOME: "/tmp" } as Record<string, string | undefined>;
const WITH_TOKEN = { HOME: "/tmp", CLAUDE_CODE_OAUTH_TOKEN: "tok-abc" } as Record<
  string,
  string | undefined
>;

describe("--remote-control: planLaunch", () => {
  test("sets the remoteControl flag", () => {
    expect(planLaunch(["--remote-control"], EMPTY).remoteControl).toBe(true);
    expect(planLaunch([], EMPTY).remoteControl).toBe(false);
  });

  test("implies the net door (RC needs egress)", () => {
    const l = planLaunch(["--remote-control"], EMPTY);
    expect(l.doors.map((d) => d.name)).toContain("net");
  });

  test("composes with an explicit --net without doubling the door", () => {
    const l = planLaunch(["--remote-control", "--net"], EMPTY);
    expect(l.doors.filter((d) => d.name === "net").length).toBe(1);
  });

  test("does not consume the next token as an argument", () => {
    const l = planLaunch(["--remote-control", "--resume"], EMPTY);
    expect(l.guestArgs).toEqual(["--resume"]);
  });
});

describe("authEnvArgs: remote-control posture", () => {
  test("omits the inference-only token even when one is present", () => {
    const l = planLaunch(["--remote-control"], WITH_TOKEN);
    const args = authEnvArgs(l, WITH_TOKEN);
    expect(args.join(" ")).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("unsets the umbrella but re-asserts the RC-safe nonessential blocks", () => {
    // The umbrella var = AUTOUPDATER + FEEDBACK + ERROR_REPORTING + TELEMETRY.
    // Only TELEMETRY breaks RC (it also kills GrowthBook). So we unset the
    // umbrella (to recover GrowthBook) and re-assert the other three granularly,
    // so a pinned box never re-enables the auto-updater / Sentry / feedback.
    const l = planLaunch(["--remote-control"], WITH_TOKEN);
    expect(authEnvArgs(l, WITH_TOKEN)).toEqual([
      "--unsetenv",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "--env",
      "DISABLE_UPDATES=1",
      "--env",
      "DISABLE_ERROR_REPORTING=1",
      "--env",
      "DISABLE_FEEDBACK_COMMAND=1",
    ]);
  });

  test("never sets a telemetry-class var (would re-break RC's GrowthBook gate)", () => {
    const joined = authEnvArgs(planLaunch(["--remote-control"], WITH_TOKEN), WITH_TOKEN).join(" ");
    expect(joined).not.toContain("DISABLE_TELEMETRY");
    expect(joined).not.toContain("DO_NOT_TRACK");
    expect(joined).not.toContain("DISABLE_GROWTHBOOK");
  });
});

describe("authEnvArgs: default posture is unchanged", () => {
  test("forwards the setup-token when present and NOT remote-control", () => {
    const l = planLaunch(["--repo", "."], WITH_TOKEN);
    expect(authEnvArgs(l, WITH_TOKEN)).toEqual([
      "--env",
      "CLAUDE_CODE_OAUTH_TOKEN=tok-abc",
    ]);
  });

  test("never unsets nonessential-traffic on a default launch", () => {
    const l = planLaunch(["--net"], WITH_TOKEN);
    expect(authEnvArgs(l, WITH_TOKEN)).not.toContain(
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    );
  });

  test("emits nothing when no token is set and not remote-control", () => {
    const l = planLaunch(["--net"], EMPTY);
    expect(authEnvArgs(l, EMPTY)).toEqual([]);
  });
});

describe("--remote-control: manifest still reflects policed egress", () => {
  test("network posture is policed (net door), not open", () => {
    const m = buildManifest(planLaunch(["--remote-control"], EMPTY), EMPTY);
    expect(m.doors.map((d) => d.name)).toContain("net");
    expect(m.netOpen).toBe(false);
  });
});

describe("rcEgressAllow: the RC profile's scoped-netd allowlist", () => {
  test("an RC launch widens the default anthropic allowlist with the RC hosts", () => {
    const allow = rcEgressAllow(planLaunch(["--remote-control"], EMPTY));
    expect(allow).toContain("api.anthropic.com"); // the default base is kept
    expect(allow).toContain("statsig.anthropic.com"); // + the RC feature-flag/telemetry host
    expect(allow).toEqual(expect.arrayContaining(RC_NETD_ALLOW));
  });

  test("--remote-serve shares the same RC allowlist", () => {
    expect(rcEgressAllow(planLaunch(["--remote-serve"], EMPTY))).toContain("statsig.anthropic.com");
  });

  test("a DEFAULT launch returns [] — it keeps the shared netd, allowlist untouched", () => {
    expect(rcEgressAllow(planLaunch(["--net"], EMPTY))).toEqual([]);
    expect(rcEgressAllow(planLaunch(["--repo", "."], WITH_TOKEN))).toEqual([]);
  });

  test("the widening is RC-only: the default never sees statsig", () => {
    expect(rcEgressAllow(planLaunch([], EMPTY))).not.toContain("statsig.anthropic.com");
  });
});

describe("--remote-serve: planLaunch", () => {
  test("sets the remoteServe flag (and not on a default launch)", () => {
    expect(planLaunch(["--remote-serve"], EMPTY).remoteServe).toBe(true);
    expect(planLaunch([], EMPTY).remoteServe).toBe(false);
    expect(planLaunch(["--remote-control"], EMPTY).remoteServe).toBe(false);
  });

  test("implies the net door (RC needs egress)", () => {
    const l = planLaunch(["--remote-serve"], EMPTY);
    expect(l.doors.map((d) => d.name)).toContain("net");
  });

  test("implies the dispatch door, but never the launcher door", () => {
    const l = planLaunch(["--remote-serve"], EMPTY);
    const names = l.doors.map((d) => d.name);
    expect(names).toContain("dispatch");
    expect(names).not.toContain("launcher");
  });

  test("composes with an explicit --launcher without doubling dispatch or dropping launcher", () => {
    const l = planLaunch(["--remote-serve", "--launcher"], EMPTY);
    const names = l.doors.map((d) => d.name);
    expect(names.filter((n) => n === "dispatch").length).toBe(1);
    expect(names).toContain("launcher");
  });

  test("composes with an explicit --net without doubling the door", () => {
    const l = planLaunch(["--remote-serve", "--net"], EMPTY);
    expect(l.doors.filter((d) => d.name === "net").length).toBe(1);
  });

  test("passes through guest args without consuming them", () => {
    const l = planLaunch(["--remote-serve", "--resume"], EMPTY);
    expect(l.guestArgs).toEqual(["--resume"]);
  });

  test("rejects non-claude guests (server mode is claude-only)", () => {
    expect(() => planLaunch(["--guest", "bun", "--remote-serve"], EMPTY)).toThrow(
      /only valid for the claude guest/,
    );
  });

  test("rejects --pod (not wired into that launch path)", () => {
    expect(() => planLaunch(["--remote-serve", "--pod"], EMPTY)).toThrow(/--pod/);
  });

  test("--repo-origin IS wired (2026-07-03): no throw, repoOrigin carries through", () => {
    const l = planLaunch(["--remote-serve", "--repo-origin", "https://x/y.git"], EMPTY);
    expect(l.remoteServe).toBe(true);
    expect(l.repoOrigin).toBe("https://x/y.git");
  });
});

describe("--remote-serve: shares the remote-control auth posture", () => {
  test("same granular nonessential-traffic posture as --remote-control", () => {
    // remote-serve is remote-control in server mode, so authEnvArgs treats them
    // identically: unset the umbrella, re-assert the three RC-safe blocks.
    const l = planLaunch(["--remote-serve"], WITH_TOKEN);
    expect(authEnvArgs(l, WITH_TOKEN)).toEqual([
      "--unsetenv",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "--env",
      "DISABLE_UPDATES=1",
      "--env",
      "DISABLE_ERROR_REPORTING=1",
      "--env",
      "DISABLE_FEEDBACK_COMMAND=1",
    ]);
    expect(authEnvArgs(l, WITH_TOKEN).join(" ")).not.toContain("DISABLE_TELEMETRY");
  });
});

describe("remoteServeArgs: the server-mode entrypoint prefix", () => {
  test("boots `claude remote-control` in --spawn session mode, named 'dispatch' (no repo)", () => {
    const l = planLaunch(["--remote-serve"], EMPTY);
    expect(remoteServeArgs(l)).toEqual([
      "remote-control",
      "--name",
      "dispatch",
      "--remote-control-session-name-prefix",
      "claude-box",
      "--spawn",
      "session",
    ]);
  });

  test("still uses --spawn session even with a repo mounted (no more worktree/same-dir split)", () => {
    const l = planLaunch(["--remote-serve", "--repo", "."], EMPTY);
    expect(remoteServeArgs(l)).toEqual([
      "remote-control",
      "--name",
      "dispatch",
      "--remote-control-session-name-prefix",
      "claude-box",
      "--spawn",
      "session",
    ]);
  });

  test("is empty for a non-serve launch (interactive entrypoint unchanged)", () => {
    expect(remoteServeArgs(planLaunch([], EMPTY))).toEqual([]);
    expect(remoteServeArgs(planLaunch(["--remote-control"], EMPTY))).toEqual([]);
  });
});

describe("bastionName: the one-persistent-bastion-per-machine guard", () => {
  test("is a stable, fixed name (not podman's random default)", () => {
    expect(bastionName()).toBe("claude-box-remote-serve");
  });
});

describe("bastionAlreadyRunning: real podman liveness (skips without podman)", () => {
  const PODMAN_READY = Bun.spawnSync(["sh", "-c", "command -v podman >/dev/null 2>&1"]).exitCode === 0;
  const podmanTest = test.skipIf(!PODMAN_READY);

  podmanTest("returns undefined or the running bastion's name", () => {
    const result = bastionAlreadyRunning();
    expect(result === undefined || typeof result === "string").toBe(true);
  });
});

describe("authLeaseFromEnvCmd: env-sourced grant for a Quadlet-managed bastion", () => {
  test("reads the grant from the named env var, base64+JSON decoded, at runtime", () => {
    const script = authLeaseFromEnvCmd("CLAUDE_BOX_RC_GRANT");
    expect(script).toContain("process.env.CLAUDE_BOX_RC_GRANT");
    expect(script).toContain('Buffer.from(g,"base64")');
    expect(script).toContain("JSON.parse");
    // No grant is ever baked into the script itself — only the env var name is.
    expect(script).not.toContain('"binding"');
    expect(script).not.toContain('"signature"');
  });

  test("still writes .credentials.json and merges oauthAccount, same as authLeaseCmd", () => {
    const script = authLeaseFromEnvCmd("X");
    expect(script).toContain(".credentials.json");
    expect(script).toContain("oauthAccount");
  });
});

describe("cmdMintAuthGrant: internal-mint-auth-grant CLI verb", () => {
  function captureStdout(fn: () => number): { code: number; lines: string[] } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      return { code: fn(), lines };
    } finally {
      console.log = original;
    }
  }

  test("requires --audience", () => {
    const { code, lines } = captureStdout(() => cmdMintAuthGrant([]));
    expect(code).toBe(1);
    expect(lines).toEqual([]);
  });

  test("prints exactly one base64 line decoding to a signed grant for the given audience", () => {
    const { code, lines } = captureStdout(() =>
      cmdMintAuthGrant(["--audience", "claude-box-remote-serve"])
    );
    expect(code).toBe(0);
    expect(lines.length).toBe(1);
    const decoded = JSON.parse(Buffer.from(lines[0]!, "base64").toString("utf-8"));
    expect(decoded.name).toBe("auth");
    expect(decoded.binding.audience).toBe("claude-box-remote-serve");
    expect(typeof decoded.signature).toBe("string");
    expect(decoded.signature.length).toBeGreaterThan(0);
  });
});

describe("cmdPrintRcBootScript: the Quadlet-managed bastion's entrypoint script", () => {
  test("prints a script that leases via the env-sourced grant, never a baked-in one", () => {
    const original = console.log;
    let printed = "";
    console.log = (...args: unknown[]) => { printed += args.map(String).join(" "); };
    try {
      expect(cmdPrintRcBootScript()).toBe(0);
    } finally {
      console.log = original;
    }
    expect(printed).toContain("process.env.CLAUDE_BOX_RC_GRANT");
    expect(printed).toContain("/home/claude/claude-box"); // RC_WORKSPACE
    expect(printed).toContain('exec claude "$@"');
    expect(printed).not.toContain('"binding"');
    expect(printed).not.toContain('"signature"');
  });
});

// ── #193: the RC guest is told its doors ─────────────────────────────────────
// Every other launch mode passes `--append-system-prompt capabilityPrompt(m)`.
// `claude remote-control` has no such flag, so the rulebook has to arrive as a
// file the guest reads on its own — $CLAUDE_CONFIG_DIR/CLAUDE.md, the "User"
// memory source. These tests pin BOTH halves: the fragment we generate, and
// that it survives an actual shell round-trip (the encoding is the whole risk).
describe("capabilityMemoryCmd: the rulebook as user memory (#193)", () => {
  const RULEBOOK = capabilityPrompt(buildManifest(planLaunch(["--net"], EMPTY), EMPTY));

  test("targets the config dir's CLAUDE.md, never the workspace", () => {
    const cmd = capabilityMemoryCmd(RULEBOOK);
    expect(cmd).toContain('process.env.CLAUDE_CONFIG_DIR');
    expect(cmd).toContain('d+"/CLAUDE.md"');
    // A repo launch runs RC in /work — the user's real worktree. Dropping a
    // project CLAUDE.md there would litter the host repo.
    expect(cmd).not.toContain("/work/CLAUDE.md");
    expect(cmd).not.toContain(`${RC_WORKSPACE}/CLAUDE.md`);
  });

  test("carries the rulebook base64-encoded, so no shell metacharacter survives", () => {
    const cmd = capabilityMemoryCmd(RULEBOOK);
    // The rulebook has quotes, parens and newlines; none may appear raw.
    expect(RULEBOOK).toContain("GRANTED:");
    expect(cmd).not.toContain("GRANTED:");
    expect(cmd).not.toContain("\n");
    const payload = cmd.match(/Buffer\.from\("([^"]*)","base64"\)/)?.[1];
    expect(payload).toBeTruthy();
    expect(payload!).toMatch(/^[A-Za-z0-9+/]+=*$/); // no quote, no $, no backtick
    expect(Buffer.from(payload!, "base64").toString("utf-8")).toBe(RULEBOOK);
    // The whole fragment is one `bun -e '…'` argument, so the ONLY single
    // quotes may be that outer pair — anything else would end the string early.
    expect(cmd.split("'").length - 1).toBe(2);
  });

  test("decodes to the EXACT rulebook when actually run by a shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-memcmd-"));
    try {
      // Deliberately nested: the fragment must create the config dir itself,
      // and adversarial content must survive `sh -c` unscathed.
      const cfg = join(dir, "nested", "config");
      const nasty = `${RULEBOOK}\n- evil: '"; rm -rf /; echo "$(whoami)" \`id\` '\n`;
      const proc = Bun.spawn(["sh", "-c", capabilityMemoryCmd(nasty)], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      expect(readFileSync(join(cfg, "CLAUDE.md"), "utf-8")).toBe(nasty);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rewrites truncating, so a previous launch's doors never linger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-memcmd-"));
    try {
      const stale = capabilityPrompt(buildManifest(planLaunch(["--keeper"], EMPTY), EMPTY));
      for (const book of [stale, RULEBOOK]) {
        const p = Bun.spawn(["sh", "-c", capabilityMemoryCmd(book)], {
          env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await p.exited).toBe(0);
      }
      const got = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      expect(got).toBe(RULEBOOK);
      // The stale GRANT is gone, not merely appended past: the second launch
      // denies keeper, and a leftover grant line would read as authority it
      // does not have.
      const GRANTED_KEEPER = "signed git writes (commit/push/refs) via keeperd";
      expect(stale).toContain(GRANTED_KEEPER);
      expect(got).not.toContain(GRANTED_KEEPER);
      expect(got).toContain("- keeper: No git-write authority in this box.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildRemoteServeScript: installs the rulebook before claude starts (#193)", () => {
  const RULEBOOK = capabilityPrompt(buildManifest(planLaunch(["--net"], EMPTY), EMPTY));

  test("writes user memory before exec'ing claude", () => {
    const script = buildRemoteServeScript({
      rcWorkspace: RC_WORKSPACE,
      leaseCmd: "echo lease",
      rulebook: RULEBOOK,
    });
    expect(script).toContain('d+"/CLAUDE.md"');
    // Ordering is the whole point: claude reads memory at startup, so the write
    // must land before the exec, and after the config dir is created.
    expect(script.indexOf('d+"/CLAUDE.md"')).toBeLessThan(script.indexOf("exec claude"));
    expect(script.indexOf('mkdir -p "$(dirname "$cfg")"')).toBeLessThan(
      script.indexOf('d+"/CLAUDE.md"'),
    );
  });

  test("omitted when no rulebook is supplied — the rest of the script is untouched", () => {
    const base = { rcWorkspace: RC_WORKSPACE, leaseCmd: "echo lease" };
    const without = buildRemoteServeScript(base);
    expect(without).not.toContain("CLAUDE.md");
    // The only difference is the inserted fragment.
    const withIt = buildRemoteServeScript({ ...base, rulebook: RULEBOOK });
    expect(withIt.replace(capabilityMemoryCmd(RULEBOOK) + " && ", "")).toBe(without);
  });

  test("fails closed: claude does not start if the rulebook cannot be written", async () => {
    const script = buildRemoteServeScript({
      rcWorkspace: RC_WORKSPACE,
      leaseCmd: "true",
      rulebook: RULEBOOK,
    });
    // `&&`, so the exec is gated on the write — an uninformed bastion is the
    // very bug this fixes, and silently booting one would hide it again.
    expect(script).toContain(`${capabilityMemoryCmd(RULEBOOK)} && cd`);
    // And the `&&` really does short-circuit: point CLAUDE_CONFIG_DIR at a
    // regular file so the mkdir -p inside the fragment cannot succeed, then
    // stand `echo STARTED` in for the `cd … && exec claude` it guards.
    const dir = mkdtempSync(join(tmpdir(), "cb-memcmd-"));
    try {
      const blocked = join(dir, "not-a-dir");
      writeFileSync(blocked, "");
      const proc = Bun.spawn(["sh", "-c", `${capabilityMemoryCmd(RULEBOOK)} && echo STARTED`], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: blocked },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).not.toBe(0);
      expect(await new Response(proc.stdout).text()).not.toContain("STARTED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a repo launch still writes to the config dir, not into /work", () => {
    const script = buildRemoteServeScript({
      repo: "/host/myrepo",
      rcWorkspace: RC_WORKSPACE,
      leaseCmd: "echo lease",
      rulebook: RULEBOOK,
    });
    expect(script).toContain("cd /work && exec claude");
    expect(script).not.toContain("/work/CLAUDE.md");
  });
});
