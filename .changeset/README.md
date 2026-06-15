# Changesets

This folder drives **release-gated GHCR publishing**. claude-box images are
*not* rebuilt on every push — they ship on a deliberate version bump, in keeping
with the project's pin-and-review ethos (see ADR.md).

## How a release happens

1. **Add a changeset with your change** (or any time before release):

   ```sh
   bun run changeset        # interactive: pick a bump (patch/minor/major) + summary
   ```

   This writes a small markdown file here. Commit it with your PR.

2. **Merge to `main`.** The `release` workflow opens (or updates) a
   **"Version Packages"** PR that consumes the pending changesets, bumps
   `package.json`, and updates `CHANGELOG.md`.

3. **Merge the Version Packages PR.** That triggers the changeset action's
   publish step (`scripts/release-tag.sh`), which pushes a `v<version>` git tag.

4. The **`publish-ghcr`** workflow fires on that tag and builds + pushes the four
   images (`claude-personal`, `keeperd`, `netd`, `scoutd`) to GHCR for
   `linux/amd64` + `linux/arm64`.

See [RELEASING.md](../RELEASING.md) for the full picture.
