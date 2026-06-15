# Contributing to claude-box

## Commit & PR conventions — [Conventional Commits](https://www.conventionalcommits.org/)

Releases are cut automatically by **release-please** from commit history, so the
message format is load-bearing, not cosmetic.

The repo **squash-merges**, which means **the PR title becomes the commit subject
on `main`** — so the *PR title* is what release-please reads. Title every PR as:

```
<type>(<optional scope>): <summary>
```

| Type | Use for | Release effect |
|---|---|---|
| `feat` | a new capability | **minor** bump |
| `fix` | a bug fix | **patch** bump |
| `feat!` / `fix!` or a `BREAKING CHANGE:` footer | incompatible change | **major** bump |
| `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `perf` | everything else | no release on its own |

Examples (matching existing PRs): `feat(remote-control): opt-in profile`,
`refactor(xdg): one hardened config path`, `fix(netd): widen allowlist`.

A `pr-title` check enforces this on every PR
([`.github/workflows/pr-title.yml`](./.github/workflows/pr-title.yml)).

## Releases

When `feat`/`fix` commits land on `main`, release-please opens a **release PR**
that bumps `version.txt` + `CHANGELOG.md`. Merging that PR tags `v<version>` and
publishes the OCI images to GHCR. The full flow — and the maintainer checklist
for the first publish — is in [RELEASING.md](./RELEASING.md).

## Tests

`bun test` is the gate (see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)).
Run it before opening a PR; no `bun install` is needed (the repo has no deps).
