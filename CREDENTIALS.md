# CREDENTIALS.md — credentials are never ambient

> A secret is never baked into the image, never persisted to the box as a
> home-of-record, and never minted by ambient login *inside* the box. Every
> credential class is carried by a **door**, mounted only when the launch grants
> it. This doc is the principle; [AUTHD.md](AUTHD.md) (RC OAuth) and
> [KEEPERD.md](KEEPERD.md) (git writes) are its two concrete instances, sitting
> under the door model in [DOORS.md](DOORS.md) and the surface in
> [CAPABILITIES.md](CAPABILITIES.md).

## Principle

In claude-box, authority is the set of door references a box holds — nothing
more. Credentials are no exception. The container is **credential-free by
design**: it gets *exactly* the authority a launch grants, and nothing ambient.
A secret reaches the box only through a dedicated door, and even then the box
holds the *least* form of it that still works.

## The doors that carry authority

See [DOORS.md](DOORS.md) for the model — a door is an ephemeral process over a
persistent capability grant; the box holds the socket, never the underlying key.

- **keeperd** (`--keeper`) — signed git writes. A git write is a *discrete
  effect*: the box asks, keeperd signs + pushes, the box never sees the signing
  key. ([KEEPERD.md](KEEPERD.md))
- **authd** (`--remote-control`) — Remote Control claude.ai OAuth. RC is *not* a
  discrete effect — it **is the session itself** — so zero-knowledge brokering is
  infeasible. The achievable ceiling: the host owns the refresh token (in op),
  authd performs the OAuth refresh and injects an **access-token-only** credential
  into the box's tmpfs, kept fresh before expiry. The box never holds the refresh
  token and never refreshes. ([AUTHD.md](AUTHD.md))
- **scoutd** (`--scout`) — external reads. **netd** (`--net`) — policed egress
  ([NETD.md](NETD.md)). **beadsd** (`--beads`) — beads reads/writes.

## What this rules out

- Long-lived tokens copied into env vars or dotfiles at image-build time.
- A credential persisting as the box's home-of-record — the exact problem authd
  exists to fix (see [AUTHD.md](AUTHD.md), "The problem RC creates").
- Ambient interactive login *inside* a box to mint durable authority.

## The contract

Absent the door, the capability is simply not present — the same **"blocked is
final"** posture as netd egress. Authority is what you *hold*, granted per
launch, revocable independently of the box by deleting the grant.
