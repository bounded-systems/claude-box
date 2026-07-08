# CLAUDE.md — working notes for agents in this repo

## `guest-room/` is a generated mirror — do not hand-edit

`guest-room/mod.ts`, `protocol.ts`, and `daemon.ts` are a **generated mirror** of
the pinned `github:bounded-systems/guest-room` flake input (see `flake.nix` and
`guest-room/README.md`). The canonical source lives upstream. Editing these files
here is overwritten on the next sync and rejected by the `guest-room-mirror`
flake check. To change the engine: edit upstream, then

```sh
nix flake update guest-room      # move the pin
nix run .#sync-guest-room        # regenerate mod/protocol/daemon
git add flake.lock guest-room/   # commit together
```

## Claude Code on the web: add repos as *sources*, not `add_repo` mid-session

This repo is often worked on from Claude Code on the web (ephemeral container,
fresh clone per session — nothing outside a committed repo persists). To work
across sibling repos (e.g. `guest-room`, `verbspec`, `conformance`), select them
as **environment sources** when starting the session. Do **not** rely on the
mid-session `add_repo` MCP tool: its interactive approval handshake does not
survive the `claude-code-remote` server reconnecting, so it can wedge on
"requires approval" and is not overridable from inside the sandbox.

## Dev basics

```sh
bun test              # unit tests, no podman needed
bun x tsc --noEmit    # type check
```
Commits/PR titles follow Conventional Commits (see `CONTRIBUTING.md`).
