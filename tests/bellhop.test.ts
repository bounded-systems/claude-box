/**
 * door-client tests — the client half of "launch bare, request a capability
 * on demand" (CONCIERGE.md §3b, REPOD.md Status). Stands up a fake concierge
 * (only implements resolve) and a fake repod-shaped tcp door (only
 * implements prepare) as real Bun.listen sockets, and exercises
 * requestRepoCheckout end-to-end — no real daemons needed, but the actual
 * wire protocol (NDJSON, {id,method,params,grant}) is real.
 *
 *   nix run nixpkgs#bun -- test tests/door-client.test.ts
 */
import { test, expect, describe, afterEach } from "bun:test";
import type { Socket } from "bun";
import { requestRepoCheckout } from "../door-client.ts";
import { unix, tcp, type SignedGrant } from "../guest-room/mod.ts";
import type { ResponseEnvelope, RequestEnvelope } from "../guest-room/protocol.ts";

function fakeGrant(port: number): SignedGrant {
  return {
    name: "repo",
    host: tcp("127.0.0.1", port),
    guest: tcp("127.0.0.1", port),
    env: "REPO_SOCK",
    grants: "repo access",
    use: "use repo",
    binding: { audience: "room-A", exp: Date.now() + 60_000, nonce: "n1", keyId: "k1" },
    signature: "fake-sig", // door-client never verifies this — repod does
  };
}

/** A minimal NDJSON tcp server exposing exactly the methods in `handlers`. */
function startFakeServer(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  let port = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket: Socket, data: Buffer) {
        for (const line of data.toString().split("\n").filter(Boolean)) {
          const req: RequestEnvelope = JSON.parse(line);
          let resp: ResponseEnvelope;
          try {
            const handler = handlers[req.method];
            if (!handler) throw new Error(`unknown method: ${req.method}`);
            resp = { id: req.id, ok: true, result: handler(req.params ?? {}) };
          } catch (e) {
            resp = { id: req.id, ok: false, error: { code: "ERR", message: (e as Error).message } };
          }
          socket.write(JSON.stringify(resp) + "\n");
        }
      },
      open() {},
      close() {},
      error() {},
    },
  });
  port = server.port!;
  return { server, port };
}

describe("requestRepoCheckout", () => {
  let repod: ReturnType<typeof startFakeServer>;
  let concierge: ReturnType<typeof startFakeServer>;

  afterEach(() => {
    repod?.server.stop(true);
    concierge?.server.stop(true);
  });

  test("resolves via concierge, then prepares via the resolved tcp door", async () => {
    repod = startFakeServer({
      prepare: (params) => ({ path: `/shared/checkouts/${params.ref}` }),
    });
    concierge = startFakeServer({
      resolve: () => ({ door: fakeGrant(repod.port) }),
    });

    const result = await requestRepoCheckout("main", `127.0.0.1:${concierge.port}`, "room-A");
    expect(result).toEqual({ ok: true, path: "/shared/checkouts/main" });
  });

  test("surfaces a concierge resolve failure (e.g. ROOM_UNKNOWN)", async () => {
    concierge = startFakeServer({
      resolve: () => {
        throw new Error("no registered room for audience \"room-A\"");
      },
    });
    const result = await requestRepoCheckout("main", `127.0.0.1:${concierge.port}`, "room-A");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("resolve failed");
  });

  test("rejects a resolved door that isn't tcp-reachable", async () => {
    concierge = startFakeServer({
      resolve: () => ({
        door: {
          name: "repo",
          host: unix("/tmp/x.sock"),
          guest: unix("/tmp/x.sock"),
          env: "REPO_SOCK",
          grants: "repo access",
          use: "use repo",
          binding: { audience: "room-A", exp: Date.now() + 60_000, nonce: "n1", keyId: "k1" },
          signature: "fake-sig",
        },
      }),
    });
    const result = await requestRepoCheckout("main", `127.0.0.1:${concierge.port}`, "room-A");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not tcp-reachable");
  });

  test("surfaces a repod prepare failure (e.g. UNAUTHORIZED)", async () => {
    repod = startFakeServer({
      prepare: () => {
        throw new Error("signed grant rejected: wrong-door");
      },
    });
    concierge = startFakeServer({
      resolve: () => ({ door: fakeGrant(repod.port) }),
    });
    const result = await requestRepoCheckout("main", `127.0.0.1:${concierge.port}`, "room-A");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("prepare failed");
  });
});
