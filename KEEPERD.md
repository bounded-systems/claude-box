# keeperd — the git-signing door (boxes write through a daemon, not raw git push)

keeperd is the git-write counterpart to launcherd. A box with the `--keeper` door
can request signed commits and pushes through keeperd, which holds the signing key
and SSH credentials. The box never holds keys — it asks **keeperd** to sign.

## Why a daemon, not raw git

| | **Raw git push** | **Door (`keeperd`)** |
|---|---|---|
| Caller | box with SSH keys / tokens | any holder of the keeperd socket |
| Credentials | in the box (privilege) | keeperd owns them; box only *asks* |
| Signing | box holds GPG/SSH key | keeperd signs; box holds no key |
| Audit | none (or git reflog) | every write logged with L3 attestation |
| Provenance | lost | **chained**: L3 links to L2 launch → L1 image |

## The grant

```
claude-box work --keeper --repo .
# → -v <keeperd.sock>:/run/keeperd.sock  --env KEEPERD_SOCK=/run/keeperd.sock
# The box asks keeperd to commit/push; keeperd owns the keys + signs.
# No SSH keys in the box, no GPG key, no escape to raw push.
```

## Wire protocol — NDJSON over unix socket

Same framing as launcherd: newline-delimited JSON, one request → one response.

### Methods

#### `status` — health check
```json
{"id":"1","method":"status"}
→ {"id":"1","ok":true,"result":{"version":"0.1.0","signing":{"enabled":true,"keyId":"..."}}}
```

#### `commit` — create a signed commit
```json
{
  "id": "2",
  "method": "commit",
  "params": {
    "repo": "/work",
    "message": "feat: add feature X",
    "author": "Claude <claude@anthropic.com>",
    "files": ["src/foo.ts", "src/bar.ts"],  // optional: specific files to add
    "all": true,                             // optional: git add -A
    "amend": false                           // optional: amend last commit
  }
}
→ {
  "id": "2",
  "ok": true,
  "result": {
    "commit": "abc123...",
    "signature": "-----BEGIN SSH SIGNATURE-----...",
    "attestation": { ... }  // L3 SLSA statement
  }
}
```

#### `push` — push to remote
```json
{
  "id": "3",
  "method": "push",
  "params": {
    "repo": "/work",
    "remote": "origin",
    "branch": "main",
    "force": false
  }
}
→ {"id":"3","ok":true,"result":{"pushed":"origin/main","commits":["abc123"]}}
```

#### `sign` — sign arbitrary data (for other attestations)
```json
{
  "id": "4",
  "method": "sign",
  "params": {
    "data": "<base64-encoded-data>",
    "format": "ssh"  // or "gpg"
  }
}
→ {"id":"4","ok":true,"result":{"signature":"<base64>"}}
```

#### `verify` — verify a signature
```json
{
  "id": "5",
  "method": "verify",
  "params": {
    "data": "<base64>",
    "signature": "<base64>"
  }
}
→ {"id":"5","ok":true,"result":{"valid":true,"keyId":"..."}}
```

## L3 attestation — git-write provenance

Every commit/push emits an L3 SLSA Provenance v1 statement:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{"digest": {"gitCommit": "abc123..."}}],
  "predicateType": "https://slsa.dev/provenance/v1",
  "predicate": {
    "buildDefinition": {
      "buildType": "https://claude.ai/buildTypes/ocap-write/v1",
      "externalParameters": {
        "capabilities": {
          "manifestDigest": {"sha256": "..."},  // same as L2!
          "doors": [{"name": "keeper", ...}]
        },
        "repo": "/work",
        "ref": "refs/heads/main"
      }
    },
    "runDetails": {
      "builder": {"id": "https://claude.ai/builders/keeperd/v1"},
      "ocap_links": [
        {"level": "launch", "digest": {"sha256": "<L2-digest>"}}
      ]
    }
  }
}
```

The `manifestDigest` in L3 **matches** L2 — this is the binding that proves the
commit came from a box with exactly those capabilities.

## Key management

keeperd holds:
- **SSH key** for git push (ed25519, `~/.claude-box/keeper.key`)
- **Signing key** for attestations (same key or separate)

The box never sees these keys — it only has the socket.

## Policy

```json
{
  "allowedRepos": ["/work", "/home/claude/repos/*"],
  "allowedRemotes": ["origin"],
  "allowedBranches": ["main", "feat/*"],
  "requireSignedCommits": true,
  "requireL3Attestation": true
}
```

## Status

**Not yet implemented.** This doc is the design target.

## Future: claude-room

All doors (keeperd, launcherd, netd, scoutd, repod) become pinned OCI images in
a shared pod. The box joins the pod; each door is a local socket mount. One room,
many doors, all auditable.
