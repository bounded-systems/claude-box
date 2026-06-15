# Releasing claude-box (GHCR images)

claude-box images ship on a **deliberate version bump**, not on every push — the
same pin-and-review stance the flake takes toward nixpkgs (see [ADR.md](./ADR.md)).
The mechanism is [release-please](https://github.com/googleapis/release-please)
(language-agnostic — no `package.json`, no deps, in keeping with the repo) plus
one GitHub Actions workflow.

## The flow

```
conventional commits ─push→ "release-please" PR ─merge→ v<version> release ─→ images on GHCR
       (you)                   (release.yml)            (release.yml)         (publish-ghcr.yml)
```

1. **Use [Conventional Commits](https://www.conventionalcommits.org/)** on `main`
   (`feat:`, `fix:`, `feat!:`/`BREAKING CHANGE:` for major). release-please reads
   them to decide the next version.

2. release-please opens or updates a **release PR** that bumps `version.txt` +
   `.release-please-manifest.json` and writes `CHANGELOG.md` from those commits.

3. **Merge the release PR.** [`release.yml`](./.github/workflows/release.yml)
   creates the `v<version>` tag + GitHub Release, then — gated on
   `releases_created` in the *same* run — calls
   [`publish-ghcr.yml`](./.github/workflows/publish-ghcr.yml).

   > We trigger the build by job dependency, **not** by the tag: a tag pushed by
   > the default `GITHUB_TOKEN` does not start a separate `on: push: tags`
   > workflow (GitHub's anti-recursion rule).

4. `publish-ghcr.yml` builds each image natively per arch (`x86_64-linux` on
   `ubuntu-latest`, `aarch64-linux` on `ubuntu-24.04-arm`), pushes arch-suffixed
   tags, assembles a multi-arch manifest per image, and moves `latest`.

### Manual / throwaway build

`publish-ghcr.yml` also accepts `workflow_dispatch` (defaults to the `dev` tag,
which is *not* promoted to `latest`) — handy for testing the pipeline without a
release.

## Published images

`ghcr.io/bounded-systems/claude-box/<image>:<version>` for:

| nix attr | GHCR image |
|---|---|
| `claude-image` | `claude-personal` |
| `keeperd-image` | `keeperd` |
| `netd-image` | `netd` |
| `scoutd-image` | `scoutd` |

## Pre-merge checklist for maintainers

Authored without a local nix/Actions runner, so confirm once on the first run:

- [ ] **Conventional commits** — the repo's history isn't conventional-commit
      formatted today; release-please won't cut a release until it sees
      qualifying commits (`feat:`/`fix:`). Adopt the convention, or seed the
      first release with a `Release-As: 0.1.0` commit footer.
- [ ] **release-please outputs** — verify the manifest-mode output names
      (`releases_created`, `.--version`) match the action version; adjust
      `release.yml` if release-please changes them.
- [ ] **Repo visibility / billing** — `ubuntu-24.04-arm` runners are free only on
      public repos; private repos need a paid ARM runner or a `qemu` cross-build.
- [ ] **Unfree licensing** — the `claude-personal` image bundles `claude-code`
      (unfree). Confirm redistribution via a public GHCR package is acceptable, or
      mark the package private.
- [ ] **Package visibility** — new GHCR packages default to *private*; set them
      public (and link to the repo) if pulls should be anonymous.
- [ ] **`docker-archive` load** — verify `skopeo copy docker-archive:result …`
      accepts the `buildLayeredImage` tarball as-is; if not, `gunzip` first.
