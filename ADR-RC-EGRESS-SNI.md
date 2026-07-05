# ADR — two-tier egress: netd (CONNECT) for normal boxes, SNI passthrough for RC boxes

> Status: **proposed** (2026-07-04). Tracking: resolves the blocker concluded in
> `ADR-DISPATCH-PATH-NAMESPACES.md` / task #20 (RC session registration 405s
> through netd). Prototyped and live-verified end-to-end before writing (see
> Evidence) — this ADR records a model that was *proven*, not just proposed.

## Context

`netd` is claude-box's egress door: a **CONNECT-only, no-MITM** allowlist proxy
(`netd.ts:6`, `:183`). It tunnels TLS blind — it only ever sees the `host:port`
of the `CONNECT` line, never cleartext — and it requires a signed grant in the
`CONNECT`'s `Proxy-Authorization` header. This is a strong, simple boundary and
it works for essentially all box traffic.

It does **not** work for Remote Control *session registration*. Live-verified:
`claude` CONNECT-tunnels normal API/inference calls through netd fine, but sends
RC registration to `POST /v1/environments/bridge` as a **forward-proxy** request
(plaintext, absolute `https://` URL). netd refuses any non-CONNECT method → 405
→ the box can't register → it exits. The bastion only escapes this by *resuming*
an existing named session; a freshly-dispatched box always registers anew, so it
always hits the wall. This is `claude`-internal, per-request transport behavior —
the box only sets `HTTPS_PROXY`; it cannot force a given request to CONNECT.

### The correction that shapes the design

The tempting fix — "keep netd, add a narrow SNI-passthrough lane for the bridge
inside the same box" — **does not work**, and it's worth stating why so no one
tries it again:

1. A forward-proxy request is **plaintext to whatever receives it**. There is no
   TLS ClientHello to SNI-inspect — an SNI lane has nothing to read. Forwarding
   it at all requires the receiver to originate TLS and see cleartext (the RC
   bearer credential) — i.e. MITM. That's the exact weakening we rejected.
2. proxy-vs-direct is a **per-process** choice (`HTTPS_PROXY` env), not
   per-request, and the bridge shares a host (`api.anthropic.com`) with the
   normal calls — so `NO_PROXY` can't split them either.

So the only no-MITM way to make the bridge work is to make `claude` issue a
**direct TLS connection** for it — which happens exactly when there is **no HTTP
proxy**. That is all-or-nothing *per box*. Hence the split is at the **box/fleet
level**, not per-request.

## Decision

**Two-tier egress, chosen per box type:**

| Box type | Egress model | Properties |
|---|---|---|
| **Normal boxes** (dev/tool/repo work) | **netd** — cooperative CONNECT proxy over a unix socket | signed-grant gated, credential-blind, fine-grained allowlist. Unchanged. |
| **RC boxes** (the bastion + dispatched sessions) | **transparent SNI-passthrough allowlist gateway** — no HTTP proxy; box does direct end-to-end TLS; gateway allows/denies by the ClientHello SNI and blind-passes the bytes | no MITM, no cleartext, no CONNECT requirement — so `claude`'s forward-proxy bridge just works. |

An RC box has **no `HTTPS_PROXY`** and a network whose only route to `:443` is the
SNI gateway. `claude` connects directly (real ClientHello, SNI = the host); the
gateway reads the SNI, checks the allowlist, connects to *that exact host*, and
pipes encrypted bytes both ways. TLS is end-to-end between the box and the real
Anthropic server — the gateway never terminates it.

This is the standard **egress-gateway TLS-passthrough** pattern (Envoy
`tls_inspector` → `sni_cluster`; Istio egress `PASSTHROUGH`; nginx `ssl_preread`;
Cilium/cloud NGFW SNI rules) — *not* an API gateway that terminates TLS.

## Evidence (live-verified 2026-07-04, before writing this ADR)

1. **Isolate the cause — direct (unproxied) egress:** an RC box with a normal
   network and NO `HTTPS_PROXY` registered a real session
   (`claude.ai/code/session_018e…`). No 405, no eligibility failure → the 405 was
   *entirely* netd's CONNECT-only proxy vs the forward-proxy bridge.
2. **Prove the secure version — through the SNI gateway:** the same RC box, on an
   isolated network with its `:443` routed to an nginx `ssl_preread` gateway
   (allowlist: `*.anthropic.com`, `claude.ai`, `*.claude.com`), registered a real
   session (`claude.ai/code/session_012w…`). The gateway logged only
   `SNI="api.anthropic.com" -> upstream="api.anthropic.com:443"` — hostname-only,
   blind passthrough, **no cleartext**.
3. **Prove the allowlist — deny path:** `example.com` routed to the same gateway
   was refused (`000`, empty upstream); `api.anthropic.com` passed through and
   returned the *real* server's `405` to an unauthenticated probe (proving the
   box validated the real cert end-to-end — no MITM).

### The prototyped gateway (nginx `ssl_preread`, stream)

```nginx
events {}
stream {
  resolver 1.1.1.1 8.8.8.8 valid=30s;
  # Allowlist by SNI. Non-matching -> empty upstream -> connection refused.
  map $ssl_preread_server_name $upstream {
    ~^([a-z0-9-]+\.)?anthropic\.com$   $ssl_preread_server_name:443;
    claude.ai                          claude.ai:443;
    ~^([a-z0-9-]+\.)?claude\.com$      $ssl_preread_server_name:443;
    default                            "";
  }
  server {
    listen 443;
    ssl_preread on;              # peek ClientHello SNI; do NOT terminate TLS
    proxy_pass $upstream;        # blind passthrough to the real host:443
    proxy_connect_timeout 5s;
    proxy_timeout 330s;
  }
}
```

## Consequences

- **RC boxes get a network namespace + the SNI gateway as their sole `:443`
  route** (replacing `--network=none` + the netd relay). In the prototype the box
  was pinned to the gateway via `--add-host <rc-host>:<gw-ip>`; production wants
  the box on an *internal* podman network with the gateway as the only egress, so
  a compromised box cannot reach non-allowlisted hosts directly.
- **Normal boxes are unchanged** — netd stays exactly as is.
- **launcherd-rs dispatch** (PRs #209/#210) would spawn the RC box onto the SNI
  egress instead of the netd relay. That's the follow-up that turns the proven
  prototype into the real dispatch path.

### Tradeoffs — named loudly (per project policy)

The SNI model is **no-MITM like netd**, but it is not strictly-superior; it trades
different risks:

- **No signed-grant gate.** netd requires a signed `net`-door grant in the
  CONNECT; the SNI gateway is allowlist-only, grant-less. RC-box egress is thus
  *less identity-gated* than netd-box egress. Acceptable because the RC box is
  already the narrowest, most-scoped box and its allowlist is tiny and fixed, but
  it IS a real difference to hold.
- **Domain-fronting residual.** The gateway allows by SNI; the encrypted HTTP
  `Host` header inside is invisible to it. A compromised box could, in principle,
  reach any service an allowlisted host's *backend* is willing to serve for a
  different `Host`. Low for a fixed Anthropic allowlist (their infra won't serve
  arbitrary Hosts), but not zero. (Note: redirect-style SNI spoofing is NOT a
  risk — the gateway connects to the SNI-named host itself, so the box can only
  reach allowlisted hosts, and gets their real cert.)
- **ECH blinds it.** If clients ever adopt Encrypted ClientHello, the SNI is
  encrypted and the gateway must fall back to IP allowlists. Not a concern for
  Anthropic today; a directional risk.
- **More moving parts** than `--network=none` + one unix socket — a netns, a
  gateway process, and its allowlist to keep correct.

### Out of scope / follow-ups
- Wiring launcherd-rs dispatch to the SNI egress (the real integration).
- Whether the bastion should also move to SNI egress (it currently "works" only
  by resuming; a fresh bastion registration would 405 through netd too).
- Upstream: `claude` CONNECT-tunneling the bridge like every other call would
  remove the need for this entirely — worth raising, and cheaper than carrying a
  second egress model long-term.

## Provenance chain
- Motivating conclusion: `ADR-DISPATCH-PATH-NAMESPACES.md`, task #20, PR #210
  comment (the 405 diagnosis).
- Egress door being refined: `NETD.md`, `netd/netd.ts`.
- Prototyped live on the podman-machine VM (Fedora CoreOS) 2026-07-04; two real
  RC sessions registered (direct, and through the SNI gateway).
