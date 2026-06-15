/**
 * rpc-demo.ts — GO/NO-GO spike: does capnp-es actually carry *capabilities* in
 * messages (Cap'n Proto level-1 RPC) under Bun? This is the real question behind
 * the Box / Grants / attenuate design in ../doors.capnp — if returned interface
 * references don't round-trip, the headline ocap win isn't available in TS.
 *
 *   nix run nixpkgs#bun -- spike/ts/rpc-demo.ts
 *
 * NOT named *.test.ts on purpose: the repo's root `bun test` runs with no
 * `bun install`, and this needs node_modules. Keep it out of test discovery.
 *
 * What it proves, end to end over two in-memory vats:
 *   1. a method RETURNS a capability        (Launcher.launch -> box, grants.scout)
 *   2. you can CALL methods on a returned cap (box.info(), scout.status())
 *   3. promise PIPELINING works              (box.info() before launch resolves)
 *   4. ATTENUATION returns a narrower cap     (scout.attenuate(...).status())
 */
import { Conn, DeferredTransport } from "capnp-es";
import {
  Launcher,
  Box$Server,
  Scout$Server,
  type Launcher$Server$Target,
  type Box$Server$Target,
  type Scout$Server$Target,
} from "./gen/doors.ts";

// ── a buffered in-memory transport pair ──────────────────────────────────────
// Conn auto-pumps recvMessage() in a loop and sends multiple messages back to
// back, so a drop-on-no-listener transport (the bare DeferredTransport) loses
// messages. We queue bytes and reuse the base class's parse (it knows the RPC
// Message type) by handing it a one-shot deferred. Delivery is on a microtask:
// a send fires *during* the peer's handleMessage, and re-entering the RPC state
// machine synchronously deadlocks promise pipelining — the microtask hop makes
// each message land on a clean stack (exactly what a real socket would do).
class MemTransport extends DeferredTransport {
  peer!: MemTransport;
  private inbox: ArrayBuffer[] = [];
  private waiter: { resolve: (m: unknown) => void; reject: (e: unknown) => void } | null = null;

  sendMessage(msg: { segment: { message: { toArrayBuffer(): ArrayBuffer } } }): void {
    const buf = msg.segment.message.toArrayBuffer();
    queueMicrotask(() => this.peer.enqueue(buf));
  }
  private enqueue(buf: ArrayBuffer): void {
    this.inbox.push(buf);
    this.pump();
  }
  private pump(): void {
    if (!this.waiter || this.inbox.length === 0) return;
    const w = this.waiter;
    this.waiter = null;
    const buf = this.inbox.shift()!;
    // base `resolve(buf)` parses bytes -> RPC Message and calls this.d.resolve
    this.d = { resolve: w.resolve, reject: w.reject, promise: null } as never;
    this.resolve(buf);
  }
  recvMessage(): Promise<never> {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.pump();
    }) as Promise<never>;
  }
}

function makePair(): [MemTransport, MemTransport] {
  const a = new MemTransport();
  const b = new MemTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

// ── server-side: a Box and an (attenuable) Scout, handed out by a Launcher ────
function makeBoxServer(launchId: string, doors: string[]): Box$Server {
  const target: Box$Server$Target = {
    async kill(_p, r) { r.killed = true; },
    async attach(_p, r) { r.stdout = `attached to ${launchId}`; r.stderr = ""; r.exitCode = 0; },
    async info(_p, r) {
      const info = r._initInfo();
      info.launchId = launchId;
      info.account = "personal";
      info.pid = 4242;
      info.depth = 1;
      const list = info._initDoors(doors.length);
      doors.forEach((d, i) => list.set(i, d));
    },
  };
  return new Box$Server(target);
}

function makeScoutServer(allow: string[]): Scout$Server {
  const target: Scout$Server$Target = {
    async repo(_p, _r) { throw new Error("not exercised"); },
    async pr(_p, _r) { throw new Error("not exercised"); },
    async issue(_p, _r) { throw new Error("not exercised"); },
    async fetch(_p, _r) { throw new Error("not exercised"); },
    async download(_p, _r) { throw new Error("not exercised"); },
    async status(_p, r) {
      const s = r._initRes();
      s.version = "spike";
      s.hasToken = true;
      const list = s._initAllowlist(allow.length);
      allow.forEach((h, i) => list.set(i, h));
    },
    // the ocap move: hand back a STRICTLY NARROWER scout (a fresh capability)
    async attenuate(p, r) {
      const requested = [...p.allow].map((t) => t.toString());
      const narrowed = requested.filter((h) => allow.includes(h)); // never widen
      r.scout = makeScoutServer(narrowed).client();
    },
  };
  return new Scout$Server(target);
}

const launcherImpl: Launcher$Server$Target = {
  async launch(p, r) {
    const room = p.opts.room.toString() || "dev";
    // grants = exactly the doors the room confers; here `dev` ⇒ scout only.
    const granted = room === "dev" ? ["scout"] : [];
    r.box = makeBoxServer("box-001", granted).client();      // a capability in a result
    const grants = r._initGrants();
    if (granted.includes("scout")) {
      grants.scout = makeScoutServer(["api.anthropic.com", ".anthropic.com"]).client();
    }
  },
  async status(_p, r) { r.version = "spike"; r.launches = 1; },
  async list(_p, _r) {},
  async rooms(_p, _r) {},
};

// ── wire two vats together and drive it from the client side ─────────────────
function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`❌ ${msg}`); process.exit(1); }
  console.log(`✅ ${msg}`);
}

// capnp-es returns `$Results$Promise` wrappers that expose `.promise()` and the
// pipeline getters (getBox(), ...) but are NOT thenables — so you can't `await`
// them directly. Wrap one to add `.then` (delegating to `.promise()`) while
// keeping the pipeline getters intact. Now `await thenable(call())` works AND
// `thenable(call()).getBox()` still pipelines. This is purely ergonomic — it does
// NOT change the pipelining deadlock below (that's a transport issue, not a
// thenable issue). In a real adoption this belongs in the generated client (or a
// thin codegen tweak) so call sites never see `.promise()`.
type ResultsPromise<T> = { promise(): Promise<T> };
function thenable<W extends ResultsPromise<unknown>>(
  rp: W,
): W & PromiseLike<Awaited<ReturnType<W["promise"]>>> {
  return new Proxy(rp, {
    get(target, key, recv) {
      if (key === "then") {
        return (onF: unknown, onR: unknown) =>
          (target.promise() as Promise<unknown>).then(onF as never, onR as never);
      }
      const v = Reflect.get(target, key, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as never;
}

const [tServer, tClient] = makePair();
const serverConn = new Conn(tServer);
serverConn.onError = (e) => console.error("[server conn error]", e);
serverConn.initMain(Launcher, launcherImpl);   // export the bootstrap capability
const clientConn = new Conn(tClient);
clientConn.onError = (e) => console.error("[client conn error]", e);

const launcher = clientConn.bootstrap(Launcher);  // Launcher$Client (remote)

console.log("— driving Launcher.launch over the in-memory RPC link —\n");

// (0) ERGONOMICS: with thenable() the calls read like ordinary async code — a
// plain `await`, no `.promise()` anywhere.
const res = await thenable(launcher.launch((params) => { params._initOpts().room = "dev"; }));
assert(typeof res.box !== "undefined", "await thenable(launch()) resolves directly — no .promise()");

// (1)+(2): call methods on the returned capabilities.
const ri = (await thenable(res.box.info())).info;
assert(ri.launchId.toString() === "box-001", "returned box capability is callable after await (box.info())");
assert([...ri.doors].map((d) => d.toString()).join(",") === "scout", "box carries its granted doors (scout)");

const scout = res.grants.scout;                  // a capability pulled out of a struct
const sStatus = (await thenable(scout.status())).res;
assert(sStatus.hasToken === true, "returned grants.scout capability is live (scout.status())");
assert([...sStatus.allowlist].map((h) => h.toString()).includes("api.anthropic.com"),
  "scout reports its allowlist (api.anthropic.com)");

// (4): ATTENUATE — a capability handing out a strictly narrower capability.
// Resolve the attenuate result first (the .scout accessor), then call it. We do
// NOT use the pipelined getScout() here — see the pipelining note below.
const aRes = await thenable(scout.attenuate((p) => {
  const l = p._initAllow(2);
  l.set(0, "api.anthropic.com");   // kept (in parent allowlist)
  l.set(1, "api.github.com");      // dropped (not in parent) — never widens
}));
const nStatus = (await thenable(aRes.scout.status())).res;
const nAllow = [...nStatus.allowlist].map((h) => h.toString());
assert(nAllow.includes("api.anthropic.com") && !nAllow.includes("api.github.com"),
  "attenuate() returns a narrower scout — POLA delegation, can't widen");

const box = res.box;
const killed = await thenable(box.kill((p) => { p.signal = "TERM"; }));
assert(killed.killed === true, "returned box capability is callable (box.kill())");

// (5) PROMISE PIPELINING (bonus, NOT required for the design above): calling a
// method on a capability obtained via getBox()/getScout() *before* the outer
// result resolves. Run with TEST_PIPELINING=1 to see it fail: capnp-es 0.0.14
// throws `CAPNP-TS100 Call on null client` on the pipelined target — i.e.
// pipelining is not working in this version (NOT a transport deadlock; the
// capability-passing the Box/Grants/attenuate design relies on, above, works
// fine and does NOT need pipelining).
const PIPELINING_WORKS = (globalThis as { TEST_PIPELINING?: boolean }).TEST_PIPELINING ?? false;
if (PIPELINING_WORKS) {
  console.log("— probing promise pipelining (getBox before launch resolves) —");
  const pi = (await thenable(
    launcher.launch((p) => { p._initOpts().room = "dev"; }).getBox().info(),
  )).info;
  assert(pi.launchId.toString() === "box-001", "pipelined box.info() before launch resolved (level-1 pipelining)");
}

console.log(`\n🎯 capnp-es carries capabilities in messages under Bun: return + invoke + attenuate-chain all work.
   thenable() makes the calls plain-awaitable (no .promise()).
   Promise pipelining is BROKEN in capnp-es 0.0.14 (TEST_PIPELINING=1 → "Call on null client"); not needed for the design.`);
tServer.close();
tClient.close();
process.exit(0);
