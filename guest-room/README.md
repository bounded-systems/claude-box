# guest-room/ — generated mirror (do not hand-edit)

These files are a **generated mirror** of the pinned [`guest-room`](https://github.com/bounded-systems/guest-room)
flake input — the canonical source. claude-box consumes the engine
(`mod.ts`) and the door runtime (`protocol.ts`, `daemon.ts`) from here, but the
truth lives upstream.

- **Do not edit these files directly.** Changes are overwritten on the next sync
  and rejected by the `guest-room-mirror` flake check (`nix flake check`), which
  fails if this directory drifts from the pinned input.
- **To update:** bump the pin and regenerate, then commit the result —
  lockfile discipline:

  ```sh
  nix flake update guest-room      # move the pin
  nix run .#sync-guest-room        # rewrite mod/protocol/daemon from the pin
  git add flake.lock guest-room/   # commit together
  ```

Files not used by claude-box (`gherkin`, the executable feature specs, the
`hotel-safe`/`room-service` secret layer) live only in the upstream repo.
