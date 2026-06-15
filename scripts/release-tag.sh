#!/usr/bin/env bash
# changesets "publish" step for a non-npm repo.
#
# The changesets action runs this once the "Version Packages" PR has merged
# (i.e. all changesets are consumed and package.json carries the new version).
# We don't publish to npm — instead we push a `v<version>` git tag, which is the
# trigger the publish-ghcr workflow listens for. Idempotent: a re-run on an
# already-tagged version is a no-op, so re-running the workflow is safe.
set -euo pipefail

version="v$(jq -r .version package.json)"

if git rev-parse -q --verify "refs/tags/${version}" >/dev/null; then
  echo "tag ${version} already exists — nothing to publish"
  exit 0
fi

git tag "${version}"
git push origin "${version}"
echo "tagged and pushed ${version}"
