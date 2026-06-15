---
"claude-box": minor
---

Publish prebuilt OCI images to GHCR on tagged releases. A changesets-driven
`release` workflow opens a Version Packages PR; merging it tags `v<version>`,
which triggers `publish-ghcr` to build and push `claude-personal`, `keeperd`,
`netd`, and `scoutd` for `linux/amd64` + `linux/arm64`. Hosts can now
`podman pull` a pinned image instead of building from the flake (see HOSTING.md).
