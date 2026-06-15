# spike/ts — capnp-es RPC go/no-go (Bun)

Proves whether `capnp-es` carries **capabilities** in messages (Cap'n Proto
level-1 RPC) under Bun, for the door schema in [../doors.capnp](../doors.capnp).
See [../README.md](../README.md) for the verdict.

## Run it

```sh
cd spike/ts
nix run nixpkgs#bun -- install              # capnp-es + typescript (isolated; root repo has no deps)

# generate gen/doors.ts from the schema. The capnp-es plugin shebang is
# `#!/usr/bin/env node`; if your node is broken, shim it to bun:
mkdir -p .shim && printf '#!/bin/sh\nexec "$(command -v bun)" "$@"\n' > .shim/node && chmod +x .shim/node
CAPNP=$(nix build nixpkgs#capnproto --no-link --print-out-paths)/bin/capnp
mkdir -p gen
PATH="$PWD/.shim:$PATH" "$CAPNP" compile --src-prefix=.. -o node_modules/.bin/capnpc-ts:gen ../doors.capnp

nix run nixpkgs#bun -- rpc-demo.ts          # all ✅ ; capability passing works
TEST_PIPELINING=1 nix run nixpkgs#bun -- rpc-demo.ts   # shows pipelining is broken in capnp-es 0.0.14
```

`gen/` and `node_modules/` are gitignored — regenerate with the steps above.
This demo is intentionally NOT named `*.test.ts`: the repo's root `bun test` runs
with no `bun install`, so it must not be discovered there.
