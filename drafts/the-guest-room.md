# The Guest Room

*Why we stopped building a box for Claude and started building a room for anyone.*

---

When a friend stays over, you don't walk them through the house pointing out which drawers are off-limits. You give them a room. There's a bed, a lamp, a door that locks from their side, a window. Everything they need for the night, and nothing that opens onto the rest of your life. The arrangement works not because you trust them less than family, but because the *room* is the unit of trust — not a list of rules you both have to remember.

We've been running coding agents the other way around. "Here's my shell, here's my repo, here's my AWS creds, please don't touch anything you shouldn't." That's not a guest room. That's handing someone your keyring and reciting the drawers.

So we built a room. This is how — and why the room turned out to have nothing to do with the guest.

---

## Act I — The houseguest problem

The instinct, when you first wire an agent into your machine, is to reach for *deny*. Sandbox it. Take away the network. Mount the repo read-only. Lock the drawers.

But an agent that can't do anything is useless, and the things it needs are exactly the dangerous things. It needs a shell, because the work is shell-shaped. It needs the repo, because that's the job. It needs to reach the model API, which means egress. It needs to commit, which means write access to git history. The capabilities you'd most like to withhold are the capabilities that make it an agent instead of a chatbot.

So "deny everything" collapses on contact. The real question isn't *how do I lock the agent out* — it's *how do I let it in without handing it the house.*

Here's the part most setups get wrong. A container feels like the answer, and it solves half the problem: a bind-mount stops the agent from wandering into the rest of your filesystem. But **a container bounds what the agent can *write*, not what it can *reach*.** Give it a mounted repo, ambient network, and a forwarded credential, and a prompt-injected or simply runaway agent never has to touch your home directory to ruin your day. It can POST the repo — and the `.env` sitting in it — to an arbitrary host, or push to your remote with your keys. It stayed perfectly inside its bind-mount and exfiltrated everything that mattered.

Confining where the guest can *write* is necessary. Confining what the guest can *reach* is the other half of the job, and it's the half that actually bites.

A furnished room, then — not a padded cell, and not a key to the house.

---

## Act II — Building the room

The room is a rootless [Podman](https://podman.io/) container, declared with [Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html), supervised by systemd. Three choices, each load-bearing:

**Rootless Podman: the guest is never the homeowner.** The container runs as a non-root user mapped into your own unprivileged uid. There's no daemon running as root to escape *to*. The guest is a guest at the level of the kernel, not by convention.

**Quadlet: the room is built from a blueprint, not assembled by hand.** A Quadlet `.container` file is a declarative unit — you describe the room and systemd builds it. Nobody is typing a thirty-flag `podman run` from memory and forgetting `--cap-drop` on a Friday. The blueprint *is* the room, which means the room can't quietly drift from what you think it is.

**systemd: the front desk.** It starts the room, restarts it if it falls over, tears it down at checkout, and writes everything to the journal.

Here is what a room's blueprint actually contains — this is a real unit we ship, lightly annotated:

```ini
[Container]
Image=localhost/keeperd:dev

# Security hardening — the furniture that isn't there
NoNewPrivileges=true       # cannot escalate via setuid/setgid
ReadOnly=true              # the root filesystem is immutable
ReadOnlyTmpfs=true         # /tmp, /run, /dev writable — and disposable
DropCapability=all         # zero Linux capabilities

# Resource limits — no fork bombs, no OOM-ing the host
PidsLimit=256
Memory=512m
```

Read that block as a description of what the room *lacks*. No ability to escalate. No writable root. No capabilities — not "fewer," none; the guest needs zero Linux capabilities to do its work, so it gets zero. A cap on processes so it can't fork-bomb the house, and a cap on memory so it can't starve it. The agent itself runs `--cap-drop=all --security-opt=no-new-privileges` as a non-root uid. These aren't grants you reason about per guest. They're the floor — the walls and the locked-from-the-inside door that every room has before you furnish it.

And the disposability is the quiet hero. `ReadOnly=true` plus a `tmpfs` workspace means the room resets at checkout. The guest writes to scratch space that evaporates when systemd tears the unit down. There is no "clean up after the agent" step because there is nothing to clean — the room un-furnishes itself.

### So how does anyone do anything?

A room with no capabilities and no network is a cell. The trick is *how* you let the necessary-but-dangerous things back in — and here's where the design earns its keep. You don't hand the guest a key. You give them a **door**.

A door is a single unix socket, bind-mounted to a fixed path inside the room. On the other side of that socket is a small daemon that holds the actual authority and enforces a policy. The guest can knock. It cannot do.

We run three doors:

| Door | What the guest can do | What the guest holds | Who holds the authority |
|---|---|---|---|
| **keeperd** | request a signed git commit/push | nothing | `keeperd` holds the signing key; runs `Network=none` |
| **netd** | reach an allowlisted host | nothing | `netd` holds the allowlist; it's the only egress path |
| **scoutd** | read an external repo/PR/URL | nothing | `scoutd` holds the read tokens; returns *content*, not creds |

Look at the "what the guest holds" column. It's *nothing*, all the way down. This is the move that separates a guest room from a keyring.

Take egress. The room runs `--network=none` — it has no network interface at all. There is no wire to exfiltrate *through*, even with a repo mounted. Its only way out is the `netd` door: a socket whose daemon owns the allowlist. The in-room entrypoint points `HTTPS_PROXY` at a loopback address that relays to the socket, so ordinary tooling Just Works — `git`, `curl`, the model SDK all think they have a proxy. Claude reaches `api.anthropic.com` *only* because netd's allowlist permits it. A `curl` to `evil.com` has no route; netd refuses, and there is no other path off the box. The grant was never "no network." It was "no *unmediated* network."

Or git writes. The room holds no SSH key, no push token, no signing key — by construction, because they live in `keeperd`, a whole process boundary away, and keeperd itself runs with `Network=none`. To commit, the room asks the door. keeperd performs the write and signs it. **The room can never push directly, because there is nothing inside it to push with.** Compare that to the usual `gh auth login`, which bundles a read client, a write client, and a credential store into one ambient tool — one login and the box is a direct push path. We deleted `gh` from the image and unbundled it into doors precisely so that "credential-free" is enforced by topology, not promised in a README.

The doors all rendezvous through one shared socket volume — they don't even need to know about each other:

```ini
# claude-doors.volume — the doors write their sockets here;
# rooms mount it read-only. The volume is the rendezvous point.
[Volume]
```

That's the room. Walls that come standard (cap-drop, read-only, no-new-privileges, disposable tmpfs), and a small set of doors — each one a socket to a broker that holds the authority and hands back only the result. The guest holds no keys. It holds a buzzer to the front desk.

---

## Act III — The room doesn't know it's Claude

We built all of this for one guest. The repo is called `claude-box`. The image ships `claude-code`. The whole thing exists to run Claude safely on a real machine.

And then, somewhere around the third door, we noticed something. **Nothing in the room is Claude-shaped.**

Go back through Act II and try to find the agent. The walls don't mention it — `cap-drop=all` is true for any process. The doors don't mention it — keeperd signs commits for *whoever knocks*; netd enforces an allowlist against *whatever* asks; scoutd returns content to *any* caller. The disposable workspace doesn't care what dirtied it. The blueprint names an image and a set of capabilities, and the image could be a coding agent today, a CI job tomorrow, an untrusted plugin the week after.

A room, it turns out, is just **walls plus a furnished set of capabilities**. The guest is a runtime detail.

Once you see it, the layering wants to come apart on its own:

| Layer | The generic primitive | The Claude-specific preset |
|---|---|---|
| capability | the **door** (a `name`, a socket) | `--keeper` / `--net` / `--scout` |
| launch | the **room** (a named bundle of doors) | `dev` = keeper + net + scout; `read` = scout only |
| product | the **guest-room framework** | **`claude-box`**, its first consumer |

A *door* is the whole capability mechanism — one `(name, socket)` pair. `--keeper` is just a named preset over a generic `--door`: a canonical in-room path plus a rulebook. A *room* is the layer above that: `--room dev` expands to a door-set for a *kind* of work, the way `--keeper` is a preset over the door primitive. Both layers are runtime-agnostic. The only Claude-shaped thing in the entire stack is the launcher that picks which preset to use — and that's one thin layer at the very top.

Which means the honest name for the abstraction isn't `claude-box` at all. It's `guest-rooms`: a generic room-and-door runtime with no mention of any particular guest. `claude-box` becomes one launcher built on it — the first room to check in, not the building.

We built a box for Claude. We ended up with a room for anyone.

### One thing the agent does need to know

There's a single place the guest's nature matters, and it's a subtle one. The room hands the agent a **rulebook** at check-in — a per-launch manifest, generated from the *same registry that mounts the doors*, listing exactly what's granted and, just as importantly, what's denied. "Your authority is EXACTLY this; if it isn't granted, you don't have it."

This is deliberately Searle's Chinese Room, the *other* room the name nods to. The agent manipulates the world only through cards it holds; a symbol with no card has no rule. No `--keeper` means no keeperd socket means *there is nothing in the room to push with* — and the rulebook tells the agent so, so it never reaches for a door that isn't there and hallucinates success. The capability's absence is real, *and* it's legible. The guest room and the Chinese Room are the same room described twice: hosted, bounded, holding no house keys, acting only through the cards it was handed.

But notice — even *that* isn't about Claude. It's about any agent that benefits from knowing its own bounds. The room stays guest-agnostic right to the edge.

---

## The next door

Walls and a ring of doors get you two things: **mechanical isolation** (the kernel won't let the guest out) and **capability isolation** (the guest can only act through brokers that hold the authority). That's a real, enforceable boundary, and for most "run an agent on my laptop" stories it's the whole answer.

But it leaves one question standing in the hallway. We've been careful about *which* doors a room holds. We've said much less about **who is allowed to install a door in the first place — and whether you can prove, after the fact, which doors a given run actually held.**

That's a provenance problem, not an isolation one. The manifest that the room hands the agent is also a hashable record of the authority a launch held — which means it can be *attested*. You can imagine a chain: a reproducible, content-addressed image, to the exact set of doors a launch was granted, to the keeper-signed commit that came out the other end. Build integrity, capability integrity, and write integrity, linked end to end, so that "this commit was produced by a run that held exactly these capabilities and no others" becomes something you can *check* rather than something you *trust*.

That's the next post. The room keeps the guest honest. The open question is who keeps the room honest — and whether the keyring itself can be made to leave a receipt.

---

*`guest-rooms` is the model; `claude-box` is its first tenant. The walls are rootless Podman, declared in Quadlet, supervised by systemd. The doors are unix sockets to broker daemons that hold the keys the room never does. If that division — capability isolation now, capability **provenance** next — is the right one, the room was never about Claude at all.*
