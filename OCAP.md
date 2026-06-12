# claude-box — lineage in the object-capability canon

claude-box is not an analogy to object-capability security; it is an **applied
OCAP system**. The doors, the credential-free box, the attenuating launcher —
each is a textbook capability primitive wearing a container-runtime costume.
This doc situates the design in the established canon (the curated reference is
[dckc/awesome-ocap](https://github.com/dckc/awesome-ocap)), so the vocabulary is
borrowed honestly rather than reinvented.

The OCAP thesis, in one line, is **"cooperation without vulnerability"**:
compose powerful patterns of authority without exposing yourself to the
authority you didn't grant. That is almost a verbatim description of
[CAPABILITIES.md](./CAPABILITIES.md).

## The mapping

| OCAP principle | claude-box mechanism |
|---|---|
| **POLA — Principle of Least Authority** | a box gets only the doors a launch grants it; `--network=none` by default, "egress is a grant." Least authority *as a container runtime*. |
| **No ambient authority** | the box holds no credentials, no podman, no keys. It *asks* a daemon (keeperd / netd / scoutd / launcherd) through a socket it was handed — capability as an unforgeable reference, nothing pulled from the environment. |
| **Capability = unforgeable reference** | the door is a unix-socket *fd*; possessing it **is** the grant. No `--keeper` ⇒ no keeperd socket ⇒ there is nothing in the box to push with. Absence is real, not advisory. |
| **Attenuation / delegation** | the launcherd work encodes the canonical delegation rule: a child box's authority ⊆ the parent's. Launch can only **narrow**, never widen — straight out of Miller's capability thesis. |
| **Confinement** | a no-grant box can think and read its mounted repo but cannot mutate anything outside its volume and has no network at all. The denied set is explicit and injected, so the box *knows* what it can't do. |

## Closest cousins in the canon

claude-box sits one layer **up** from the OS-level capability systems — it is
capability security for *AI agents*, built on commodity container primitives
rather than a custom kernel — but the nearest relatives are clear:

- **FreeBSD Capsicum** — the tightest analogue: capability mode plus
  rights-limited file descriptors ≈ our door sockets. A process in capability
  mode can only act through the fds it already holds, exactly as the box can
  only act through the doors it was handed.
- **seL4 / Genode / Fuchsia** — the OS-level expression of the same idea
  (capabilities as the *only* authority). claude-box doesn't reimplement these;
  it borrows their model and projects it onto `podman run` mounts and sockets.

Under awesome-ocap's own taxonomy, claude-box would land in **"Technology You
Can Use → Applications"** — a rare *applied, agent-facing* OCAP system, a
category that list is light on. The OS-capability entries describe the kernel;
claude-box is what using that model looks like for an agent runtime.

## Why borrow the vocabulary

Naming the lineage is not decoration. It buys three things:

1. **The hard cases are already solved on paper.** Delegation, revocation,
   confinement, the difference between designation and authority — the OCAP
   literature worked these out decades ago. When a launcherd question gets
   subtle, the answer usually already has a name.
2. **Honesty about the gaps.** Calling something a capability commits us to
   *unforgeability* — if a "door" can be faked or bypassed, it isn't one. The
   canon is the spec the implementation is held to.
3. **Findability.** If claude-box ever plants a flag in that ecosystem, it fits
   the awesome-ocap framing — "compose powerful patterns of cooperation without
   vulnerability" — with almost no translation.

See [CAPABILITIES.md](./CAPABILITIES.md) for the concrete surface this lineage
describes, and [LAUNCHERD.md](./LAUNCHERD.md) for the attenuation/delegation
rule in code.
