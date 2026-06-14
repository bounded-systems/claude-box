# Red-team harness — Claude as a bad actor

Probes claude-box's OCAP containment by pointing **headless Claude** at the box
with adversarial goals and checking, from *outside*, whether the boundary held.

## The one principle

**The adversary never grades its own success.** An LLM that reports "I couldn't
escape" is worthless. So:

> Headless Claude is the **fuzzer** — it improvises escape attempts.
> External, deterministic invariants are the **oracle** — they decide the verdict.

The harness plants canaries and capability-violation goals, lets Claude try
hard, then judges from signals the agent can't fake:

| Signal | Source |
|---|---|
| egress reached a forbidden host? | netd's `ALLOW`/`DENY` log (`oracle.ts`) |
| host / `.git` / other-account file touched? | filesystem canaries |
| remote advanced without the keeper door? | keeperd audit + `git ls-remote` |
| an ungranted door was usable? | door socket reachability |

## Two tiers

- **Deterministic probes** (`tests/ocap.test.ts`, incl. `red-team/*`) — scripted
  escape attempts. **CI-gated.** Fast, reproducible.
- **LLM red-team** (this dir) — headless Claude. **On-demand discovery.**
  Nondeterministic, costs tokens, needs an authed account. NOT in CI.

The loop: the LLM discovers a novel escape once → you harden → add a
deterministic probe so it can never silently return.

## Layout

| File | Purpose | CI |
|---|---|---|
| `oracle.ts` | pure verdict layer (parse netd log, check canaries) | ✅ unit-tested |
| `oracle.test.ts` | tests the oracle against real netd log lines | ✅ |
| `missions.ts` | the 5 missions (goal + profile + oracle spec) | data |
| `harness.ts` | launches box, runs headless Claude, gathers observations | on-demand |
| `run.ts` | runner + containment report | on-demand |

## Missions

`exfil` · `host-rce` · `bypass-keeper` · `escape` · `escalate` — each maps 1:1
to an OCAP invariant (`bun tests/redteam/run.ts --list`).

## Running

```bash
# enumerate missions (no runtime needed)
bun tests/redteam/run.ts --list

# CI-safe oracle unit tests
bun test tests/redteam/oracle.test.ts

# full red-team (needs: nix run .#setup, doors serving, authed account)
bun tests/redteam/run.ts                 # all missions
bun tests/redteam/run.ts exfil escape    # specific
```

Exit is non-zero if any mission reports a breach. Override the headless flags
with `REDTEAM_CLAUDE_ARGS` (default `-p --dangerously-skip-permissions` — running
tools without prompts is fine *because* it's inside the sandbox).

> Authorized use only: this exercises containment of a sandbox **you own**.
