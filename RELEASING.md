# Releasing claude-box (GHCR images)

claude-box images ship on a **deliberate version bump**, not on every push — the
same pin-and-review stance the flake takes toward nixpkgs (see [ADR.md](./ADR.md)).
The mechanism is [changesets](https://github.com/changesets/changesets) +
two GitHub Actions workflows.

## The flow

```
PR with a changeset ──merge──▶ "Version Packages" PR ──merge──▶ v<version> tag ──▶ images on GHCR
        (you)                      (release.yml)               (release-tag.sh)     (publish-ghcr.yml)
```

1. **Author a changeset** alongside your change:

   ```sh
   bun install            # one-time, pulls @changesets/cli
   bun run changeset      # pick patch/minor/major + write a summary
   git add .changeset && git commit
   ```

2. **Merge to `main`.** [`release.yml`](./.github/workflows/release.yml) opens or
   updates a **Version Packages** PR that bumps `package.json` and `CHANGELOG.md`
   from the pending changesets.

3. **Merge the Version Packages PR.** With no changesets left, the changeset
   action runs the publish step ([`scripts/release-tag.sh`](./scripts/release-tag.sh)),
   which pushes a `v<version>` tag (idempotent).

4. [`publish-ghcr.yml`](./.github/workflows/publish-ghcr.yml) fires on the tag and:
   - builds each image natively per arch (`x86_64-linux` on `ubuntu-latest`,
     `aarch64-linux` on `ubuntu-24.04-arm`) and pushes an arch-suffixed tag, then
   - assembles a multi-arch manifest per image and moves `latest`.

## Published images

`ghcr.io/bounded-systems/claude-box/<image>:<version>` for:

| nix attr | GHCR image |
|---|---|
| `claude-image` | `claude-personal` |
| `keeperd-image` | `keeperd` |
| `netd-image` | `netd` |
| `scoutd-image` | `scoutd` |

A manual build (no version bump) is available via the workflow's
`workflow_dispatch` (defaults to the `dev` tag).

## Pre-merge checklist for maintainers

This setup was authored without a local nix/Actions runner, so confirm once on
the first real run:

- [ ] **Repo visibility / billing** — `ubuntu-24.04-arm` runners are free only on
      public repos; private repos need a paid ARM runner or a `qemu` cross-build.
- [ ] **Unfree licensing** — the `claude-personal` image bundles `claude-code`
      (unfree). Confirm redistribution via a public GHCR package is acceptable, or
      mark the package private.
- [ ] **Package visibility** — new GHCR packages default to *private*; set them
      public (and link to the repo) if pulls should be anonymous.
- [ ] **`docker-archive` load** — verify `skopeo copy docker-archive:result …`
      accepts the `buildLayeredImage` tarball as-is; if not, `gunzip` first.
