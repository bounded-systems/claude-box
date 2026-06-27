# GitAI provenance — AI authorship as a *verifiable* claim, not an attested one

> Status: **design record** (2026-06-27). Phase 1 (the in-box checkpoint hook)
> ships in this PR; Phase 2 (keeperd reconciliation) is specced here and tracked
> separately. Builds on [KEEPERD.md](./KEEPERD.md) (the signed git-write door)
> and the GitAI integration (`git-ai` shipped in the image, #152).

## The claim we want to be able to make

"This commit's AI-authored hunks were produced by the model, through the box —
and any hunk that was **not** is flagged." Stated as a property, not a promise:

- **Verifiable** — the authorship record is *signed by keeperd*, the same key
  that signs the commit and its L3 attestation. Not "the box says so."
- **Bypass-detectable** — if a file lands in the commit that the model never
  checkpointed (a human edit, a script, a non-hooked process), the divergence is
  recorded. We can tell *when the model was bypassed*.

This is the [trust-ledger](https://github.com/bounded-systems/trust) ethos
applied to authorship: **verifiable, not merely attested.**

## Why one record isn't enough

A single in-box record can't carry the claim, because the box is exactly the
thing that might be bypassed:

| Record | Who writes it | Trust | What it proves alone |
|---|---|---|---|
| **In-box checkpoint** (the hook) | the box, at Edit/Write time | self-report — a bypass leaves no trace *by construction* | what the model *claims* it authored |
| **keeperd attestation** (signed) | keeperd, at commit time | authoritative — holds the key, sees the real diff | what *actually* got committed |

The **claim lives in the relationship between the two**, not in either one. The
model's self-report says "I authored A, B"; keeperd sees the commit touches
A, B, C; the signed record says "AI: A, B — **divergent: C**." C is the bypass,
and the statement that says so is signed.

## The two records

### Record 1 — in-box checkpoint (Phase 1, this PR)

Claude Code `PreToolUse`/`PostToolUse` hooks (managed settings at
`/etc/claude-code/managed-settings.json`) run `git ai checkpoint claude` on
Edit/Write. This is the **model's self-report**: which files the hooked model
touched, with the transcript context git-ai's `claude` preset extracts.

It is deliberately **not** authoritative. It records model *intent*; it cannot
prove the absence of un-hooked edits. That's Record 2's job.

> Note: git-ai's default `git_notes` backend writes to `.git`, which the default
> hardened box mounts **read-only**. So Record 1 persists to `.git` only in
> `--repo-rw` boxes. Phase 2 removes this dependency entirely (below): the
> authoritative record never needs a box-side `.git` write.

### Record 2 — keeperd reconciliation (Phase 2, specced)

keeperd already owns `.git` writes and emits a signed L3 SLSA attestation per
commit (KEEPERD.md §"L3 attestation"). Extend `commit` to **bind authorship**:

1. The box's `commit` request carries the model's claimed authorship — the
   checkpoint set from Record 1 (claimed AI-authored paths/hunks + the
   checkpoint/transcript ids).
2. keeperd computes the **actual** staged diff (it controls `git add`/`commit`).
3. keeperd **reconciles** claimed vs. actual, per file (ideally per hunk):
   - **matched** → AI-authored, recorded as such.
   - **in-diff, unclaimed** → `divergent` (bypass: human / untracked tool).
   - **claimed, not-in-diff** → `stale` (claimed but never landed).
4. keeperd records the reconciliation in the **signed** L3 attestation (a
   `authorship` block alongside `ocap_links`) and signs the commit. The notes /
   attestation are written by **keeperd**, with keeperd's authority — the box
   writes nothing to `.git`.

```jsonc
// added to keeperd commit → result.attestation.predicate
"authorship": {
  "model": "claude-opus-4-8",
  "checkpointSource": "git-ai/claude",          // Record 1 producer
  "aiAuthored":  ["src/foo.ts", "src/bar.ts"],  // claimed ∩ actual diff
  "divergent":   ["src/legacy.ts"],             // in diff, NOT claimed → bypass
  "stale":       []                             // claimed, not in diff
}
```

Because this rides the commit keeperd **already signs**, it works in the default
hardened box (read-only `.git`, no egress) — the constraint that blocks Record 1
on its own simply doesn't apply to Record 2.

## Why this is the explicit, claims-tied answer

- **In keeperd** (authoritative): authorship is bound at the sanctioned write
  boundary, signed by the same key as the commit, chained to L2/L1 via
  `manifestDigest`. The record is as trustworthy as the commit signature itself.
- **And not (only) in keeperd** (bypass-detectable): the *independent* in-box
  self-report is what keeperd reconciles against. Without a second, independently
  produced record, "what the model did" and "what got committed" are the same
  number and divergence is invisible. Two records → the gap is measurable →
  bypass is a signed, verifiable finding.

## Phasing

1. **Phase 1 (this PR):** in-box checkpoint hook. Records model self-report;
   persists in `--repo-rw` boxes. Standalone value: authorship in dev boxes
   today; the self-report channel Phase 2 reconciles against.
2. **Phase 2 (tracked):** `keeperd commit` accepts claimed authorship, reconciles
   against the real diff, records `aiAuthored`/`divergent`/`stale` in the signed
   L3. Removes the read-only-`.git` limitation. The box passes its checkpoint set
   to keeperd instead of (or in addition to) writing git notes itself.
3. **Phase 3 (later):** hunk-level reconciliation (not just file-level);
   `git ai blame`/`log` reads the keeper-signed authorship; upstream the
   integration to `git-ai-project/git-ai` README Agent Support.

## Open questions

- **Carrying Record 1 to keeperd.** The in-box hook writes git-notes (needs rw
  `.git`). For the hardened box, the model self-report must reach keeperd without
  a box-side `.git` write — a checkpoint sink keeperd reads (a writable scratch
  path, or the `commit` request payload). Likely: hook writes claims to a
  box-local file; `lib/keeper.ts commit` includes them.
- **Hunk vs. file granularity.** File-level divergence is the v1; hunk-level
  (a human-edited region inside an AI-authored file) is stronger and matches
  git-ai's own line-stats model.
- **Replay / freshness.** Bind the claimed-authorship set to the commit (the
  staged tree hash) so a stale checkpoint set can't be replayed onto a different
  diff — same `audience`/`nonce` shape the signed-grant work uses.
