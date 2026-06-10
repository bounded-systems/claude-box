# repod — the repo door (the repo as a service, not raw fs)

Today `--repo` bind-mounts the worktree **and the git common dir** read-write at
their host paths (`claude-box.ts`). That makes the repo *raw host fs* inside the
box, and it's the sharpest hole in the design: the box can write **`.git/config`
and `.git/hooks/`**, which then execute **on the host** the next time you run git
outside the container (`core.hooksPath`, `core.pager`, `core.fsmonitor`,
`alias.*`, a `post-checkout` hook…). Code execution on the host, no push
required — the credential-free + netd-door model doesn't cover it.

The fix is to stop handing out raw fs and make the repo a **door**, the fs twin
of keeperd (git writes), beadsd (beads), and netd (egress): the box (and other
consumers — **Scout** and friends) talk to **repod**, which *owns* the canonical
store. The box never sees the host's real `.git`.

## Read and write are separate capabilities — gated independently

The escape comes from conflating "see the code" with "mutate the repo." repod
splits them:

| Capability | Door | What it grants | Used by |
|---|---|---|---|
| **read** | repod read door | the repo's *content* — files, blobs, tree at a rev — as a **read-only projection**, never the host `.git` | Claude reading code, **Scout**, indexers, any consumer |
| **edit** | in-box overlay | a writable working copy *inside the box* (ephemeral overlay over the read-only lower); host store untouched | the box, while it works |
| **write** | keeperd door | turn in-box edits into **commits/refs**, validated + signed, applied to the canonical store | the box, on request |

No grant ⇒ the box can't see the repo. `read` ⇒ it can look but not mutate
anything that reaches the host. `write` is keeperd's job (already a door), so a
commit is a *request* keeperd performs against the real store — the box still
holds no keys and now also has no writable `.git`. **#1 is closed:** there is no
`.git/config` or hook on a host path that the box can write.

## Why a service, not just `:ro`

The cheap version — mount the worktree `:ro` and drop the `${common}:${common}`
mount — does close the escape, but a read-only `.git` breaks ordinary git (index
locks, `FETCH_HEAD`, refs all want writes), so the box can't even `git status`
cleanly. The service fixes usability *and* safety:

- **reads** come from repod (a content API, or a read-only lower it exports),
- **edits** land in an **in-box overlay** (writable, ephemeral, thrown away with
  the `--rm` container) — so Claude/Scout edit freely without touching the host,
- **history writes** go to keeperd, which applies a reviewed commit to the
  canonical store.

The box gets a normal-feeling working tree; the host's `.git` is never writable
from inside the box; and the same repod door serves **many consumers** at once
(Scout indexing, a second box, a reviewer) — each gated to `read` unless granted
more. That's the point of "repo as a service": one owner of the store, many
capability-scoped consumers, zero raw fs.

## Transport — same door model

A unix-socket door (`-v <repod.sock>:/run/repod.sock`), interchangeable with the
other transports in CAPABILITIES.md ("Transport is interchangeable"). End-state:
repod / keeperd / beadsd / netd are pinned OCI images in one podman pod
(`prx-zj8`), and the box joins the pod so every door is a direct local mount.

## Launcher shape (design)

```
claude-box work --repo .            # read door only — see code, can't mutate the host repo
claude-box work --repo . --keeper   # + keeper write door — commits go through keeperd
# (raw RW bind-mount of the git common dir is RETIRED)
```

`--repo` stops meaning "bind-mount the host worktree RW" and starts meaning
"attach the repod read door + an in-box overlay." `--keeper` adds history
writes. Read and write are now two flags, two doors, two grants.

## Status

Design. Today `--repo` is still the raw RW bind-mount (the hole this doc
describes). Migration:

1. **interim, now:** drop the `${common}:${common}` RW mount; mount the worktree
   `:ro`; route commits through keeperd. Closes the escape; degrades in-box git
   (documented).
2. **repod, next:** stand up repod (read projection) + the in-box overlay so the
   working tree is usable again and Scout/other consumers share one door.

Pairs with NETD.md (egress door) and the keeperd/beadsd doors — the repo is the
last raw-fs grant to become a capability.
