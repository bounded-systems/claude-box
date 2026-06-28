/**
 * @module
 * interpose.ts — caveat enforcement by INTERPOSITION (prx-yweb / trust ledger 6.3).
 *
 * `checkCaveats()` and `attenuatesDoors()` (mod.ts) prove a narrowed grant is
 * monotone — narrowing only ever removes authority. But they enforce narrowing as
 * **metadata**: a delegated child still holds the *same upstream reference*, and
 * the caveat check runs only where the serving broker chooses to run it. A child
 * that holds the upstream socket can simply connect to it directly, unnarrowed —
 * the caveats were a string it was trusted to honor, not a boundary.
 *
 * An **interposer** makes narrowing **structural**. It holds the upstream
 * reference and serves its OWN door; the child is handed only the interposer's
 * reference. Every request passes through `checkCaveats` against the grant's
 * caveats before being forwarded upstream — a denied request never reaches it.
 * The narrowed door is now a genuinely weaker *capability* (an object that can do
 * strictly less), not a claim the child is trusted to respect.
 *
 * This is the enforcement PRIMITIVE for prx-86g9 (object-anchored capabilities):
 * spawn hands a child the interposer's socket, never the upstream's, so
 * over-granting is unsayable rather than rejected. Wiring it into claude-box
 * spawn is gated on reference-passing spawn (prx-8k08); this module is that
 * primitive, prototyped and tested in isolation. Further attenuation composes:
 * an interposer in front of an interposer is a doubly-narrowed door, and because
 * caveats are append-only (`attenuate`), authority only ever shrinks down a chain.
 *
 * It reuses, rather than replaces, the existing model: `checkCaveats` is the
 * per-request gate the interposer runs; the broker still owns the verifier
 * grammar (the engine stays domain-agnostic); signed grants (prx-79id) carry
 * authority *in transit* on tcp/vsock, while interposition enforces authority *as
 * structure* for a held unix reference.
 */

import { Buffer } from "node:buffer";

import { type CaveatVerifiers, type DoorGrant, checkCaveats } from "./mod.ts";
import {
  type DoorSocket,
  type RequestEnvelope,
  type ResponseEnvelope,
  call,
  err,
  ok,
} from "./protocol.ts";

/** The context a caveat is checked against, derived from each request. The
 *  default: the request's own method + params, so a verifier like
 *  `method: (v, ctx) => ctx.method === v` enforces `method=read`. */
export type InterposeContext = { method: string; params: Record<string, unknown> };

/** A forwarder: send a request to the upstream and resolve its result. Matches
 *  protocol `call`; injectable so the enforcement core is testable without a
 *  socket. */
export type Forwarder = (
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
  opts?: { auth?: string; sign?: (req: RequestEnvelope) => string },
) => Promise<unknown>;

export interface InterposerOptions<Ctx = InterposeContext> {
  /** The upstream door endpoint the interposer holds — and the child never sees. */
  upstream: string;
  /** The grant whose caveats are enforced on every forwarded request. */
  grant: DoorGrant;
  /** Verifiers interpreting each caveat key against the derived context. */
  verifiers: CaveatVerifiers<Ctx>;
  /** Derive the caveat-check context from a request (default: the request itself). */
  deriveContext?: (req: InterposeContext) => Ctx;
  /** Credentials the interposer presents to the UPSTREAM (it is the upstream's client). */
  upstreamAuth?: { auth?: string; sign?: (req: RequestEnvelope) => string };
  /** The forwarder (default: protocol `call`); injectable for tests. */
  forward?: Forwarder;
  /** Audit hook. */
  log?: (level: "ALLOW" | "DENY" | "ERR", msg: string) => void;
}

function deriveDefault<Ctx>(req: InterposeContext): Ctx {
  return req as unknown as Ctx;
}

/**
 * Enforce the grant's caveats on one request, forwarding it upstream iff every
 * caveat holds. A denied request returns a `CAVEAT_DENIED` error and is **never**
 * forwarded — this is the interposition guarantee: the boundary is the proxy, not
 * the caller's good behavior.
 */
export async function enforceAndForward<Ctx = InterposeContext>(
  req: RequestEnvelope,
  opts: InterposerOptions<Ctx>,
): Promise<ResponseEnvelope> {
  const derive = opts.deriveContext ?? deriveDefault;
  const ctx = derive({ method: req.method, params: req.params ?? {} });
  const verdict = checkCaveats(opts.grant, ctx, opts.verifiers);
  if (!verdict.ok) {
    opts.log?.("DENY", `${req.method}: caveat "${verdict.caveat}" ${verdict.reason}`);
    return err(req.id, "CAVEAT_DENIED", `caveat not satisfied: "${verdict.caveat}" (${verdict.reason})`);
  }
  const forward = opts.forward ?? call;
  try {
    const result = await forward(opts.upstream, req.method, req.params ?? {}, opts.upstreamAuth);
    opts.log?.("ALLOW", req.method);
    return ok(req.id, result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    opts.log?.("ERR", `${req.method}: upstream ${message}`);
    return err(req.id, "UPSTREAM_ERROR", message);
  }
}

interface InterposerConn {
  buffer: string;
}

/**
 * Socket handlers for an interposer door — newline-delimited JSON, the same wire
 * format as {@link createDoorHandlers}, but every request is caveat-checked and
 * then forwarded to the upstream the interposer holds (instead of dispatched to a
 * local method registry). Bind with `Bun.listen({ unix, socket })` and hand the
 * child only this socket's path.
 */
export function createInterposerHandlers<Ctx = InterposeContext>(opts: InterposerOptions<Ctx>): {
  open: (socket: DoorSocket<InterposerConn>) => void;
  data: (socket: DoorSocket<InterposerConn>, chunk: Uint8Array) => Promise<void>;
  close: (socket: DoorSocket<InterposerConn>) => void;
  error: (socket: DoorSocket<InterposerConn>, error: Error) => void;
} {
  return {
    open(socket) {
      socket.data = { buffer: "" };
    },
    async data(socket, chunk) {
      socket.data.buffer += Buffer.from(chunk).toString("utf-8");
      const lines = socket.data.buffer.split("\n");
      socket.data.buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        let response: ResponseEnvelope;
        try {
          const req = JSON.parse(line) as RequestEnvelope;
          response = await enforceAndForward(req, opts);
        } catch {
          response = err("?", "PARSE_ERROR", "invalid JSON");
        }
        socket.write(JSON.stringify(response) + "\n");
      }
    },
    close() {},
    error(_socket, error) {
      opts.log?.("ERR", `socket error: ${error.message}`);
    },
  };
}
