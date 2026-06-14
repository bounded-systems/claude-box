# Spike: Cap'n Proto as the door wire protocol

**Status:** exploratory. Nothing here is wired into the build. `doors.capnp`
compiles clean against `capnp` 1.4.0 (`capnp compile -o- spike/doors.capnp`).

## Go/no-go result (empirical)

The TS side is exercised in [ts/rpc-demo.ts](ts/rpc-demo.ts) — two in-memory vats
over the generated `capnp-es` stubs, run under Bun
(`nix run nixpkgs#bun -- spike/ts/rpc-demo.ts`). Verdict: **GO for the design.**

- ✅ **Code generation** — `capnp-es` generates full RPC stubs (`$Client`,
  `$Server`, `$Promise`) from `doors.capnp` under Bun.
- ✅ **Capabilities ride in messages** — `Launcher.launch` returns a `Box` cap
  and `Grants.scout` cap; the client invokes `box.info()` / `scout.status()` on
  the returned references. This is the headline ocap win, and it **works**.
- ✅ **Attenuation chains** — `scout.attenuate(allow)` returns a *narrower* `Scout`
  cap that the client then calls. POLA delegation works.
- ✅ **Ergonomics via thenable wrapper** — capnp-es returns `$Results$Promise`
  objects that aren't real thenables (you must call `.promise()`). A ~12-line
  `thenable()` Proxy adds `.then` while keeping the pipeline getters, so call
  sites read as plain `await launcher.launch(...)`. In real adoption this belongs
  in the generated client.
- ❌ **Promise pipelining** (calling a method on `getBox()`/`getScout()` *before*
  the outer result resolves) is **broken in capnp-es 0.0.14**: `TEST_PIPELINING=1`
  surfaces `CAPNP-TS100 Call on null client` on the pipelined target. This is a
  library limitation, not a transport artifact (the core capability passing above
  runs over the same transport). **It is a bonus, not a prerequisite** — the
  Box/Grants/attenuate design uses resolved capabilities and does not need it.

Correction to an earlier claim in this doc: the Box/attenuate pattern needs
**level-1** RPC (capabilities in results over one connection), *not* level-3
(three-party handoff). Level-1 capability passing is what the demo proves works;
promise pipelining (also level-1 in the spec) is the one piece capnp-es 0.0.14
doesn't deliver here.

## Why

The door fleet already *is* an object-capability system at the OS layer
([CAPABILITIES.md](../CAPABILITIES.md) calls it "an applied object-capability
system, not a loose analogy"). But the **wire** under the doors is a hand-rolled
envelope:

```ts
type RequestEnvelope  = { id: string; method: string; params?: Record<string, unknown> };
type ResponseEnvelope = { id: string; ok: boolean; result?: unknown; error?: {...} };
```

duplicated verbatim in [lib/keeper.ts:123](../lib/keeper.ts), [lib/scout.ts:174](../lib/scout.ts),
[lib/spawn.ts:122](../lib/spawn.ts) (and mirrored daemon-side). `method` is a free
string; payloads are `unknown`. So the *capability* is enforced (you must possess
the socket fd), but the *protocol over it* is untyped and triplicated.

Cap'n Proto is capability-RPC: the schema's `interface` **is** a capability, and
references can be passed inside messages. That matches the door model exactly.

## What the schema demonstrates

| Today (ad-hoc JSON) | With `doors.capnp` |
|---|---|
| `method: string`, `params: unknown` | typed methods on `Keeper` / `Scout` / `Launcher` |
| envelope duplicated in 3 lib files + daemons | one schema, generated both sides |
| `kill(launchId)` — **forgeable bearer string** | `Box.kill()` — method on a held capability |
| room = a list of door *names* in a manifest | `Grants { keeper; scout; net }` — non-null caps **are** the room |
| attenuation is undocumented/impossible | `Scout.attenuate(allow)` → a narrower `Scout` |

The two methods worth focusing on:

- **`Launcher.launch -> (box :Box, grants :Grants, attestation)`** — instead of
  returning a `launchId` string the caller later passes back, it returns a `Box`
  *capability* plus capabilities to exactly the granted doors. "No ambient
  authority; delegated by dispatch" ([DOORS.md:43](../DOORS.md)) becomes a return
  type. Possession of the `Box` is the authority to `kill`/`attach` it — there is
  no string to forge.

- **`Scout.attenuate` / `Net.attenuate`** — hand a sub-task a *strictly narrower*
  door (smaller allowlist). POLA delegation that the current `{method, params}`
  envelope has no way to express.

## What it does and doesn't close

- **Closes:** protocol triplication; untyped `method`/`params`; the forgeable
  `launchId` bearer pattern in `lib/spawn.ts`.
- **Helps with, doesn't fully close:** the TCP-mode possession gap that
  [CAPABILITIES.md:129-156](../CAPABILITIES.md) flags. Cap'n Proto level-3 RPC
  carries capabilities across the wire, so a returned `Box`/`Scout` ref is real
  possession rather than "anyone who can reach `127.0.0.1:PORT`." But over plain
  TCP you still want the connection itself authenticated (TLS/mTLS or a unix
  socket); capnp gives you the *model*, not the transport security for free.
- **Out of scope:** the box↔guest boundary. The guest runs untrusted generated
  code; capnp (a library it could ignore) changes nothing there. That boundary
  stays enforced by podman + `--network=none` + the socket doors. capnp is for
  the **door protocol**, not the sandbox.

## Migration path (if pursued)

1. Keep the unix-socket doors and the daemons; swap only the framing. Wire
   capnp-es's `Conn` over a real socket transport (the demo's `MemTransport`
   shows the shape: serialize via `msg.segment.message.toArrayBuffer()`, parse on
   recv).
2. Generate TS from `doors.capnp` (`capnp` + `capnp-es`), replace the three copied
   `request()` helpers with one generated client. Fold the `thenable()` wrapper
   into that client so call sites never see `.promise()`.
3. Daemon-side: dispatch on the typed `$Server` target instead of `switch (method)`.
4. Land `Launcher.launch` returning a `Box` cap last — it's the biggest change
   (drops the launchId lookup table) and the biggest ocap win. It needs only the
   capability-return path, which works today; it does NOT depend on pipelining.

### Honest caveat

The JS/TS Cap'n Proto ecosystem is less mature than C++/Rust/Go. This spike
**empirically confirms** capability passing (return + invoke + attenuate) works in
`capnp-es` 0.0.14 under Bun — but **promise pipelining is broken** there
(`Call on null client`). Implications:

- The `Box` / `Grants` / `attenuate` design is safe to pursue — it uses resolved
  capabilities, which work.
- Don't design anything that *depends* on pipelining (calling through a not-yet-
  returned cap in one round trip) until capnp-es fixes it or you switch libs.
- If even capability passing had failed, the fallback that still kills the
  triplication and `unknown` payloads is a single shared typed envelope
  (zod/Pydantic) — less elegant, no capnp RPC bet. That fallback is now the
  *second* choice, not the first.
