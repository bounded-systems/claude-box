/**
 * door-bridge e2e (prx-8uf2) — the bridge carries a SIGNED GRANT across the
 * unix→tcp boundary to a REAL grant-gated door, end to end on real sockets:
 * a tcp "scout" door guarded by the same `signedGrantAuthorizer` scoutd/keeperd
 * use, fronted by `frontDoorsWithInterposers`, called through the unix proxy.
 *
 * This is the platform-agnostic half of the bridge (pure crypto + sockets, no
 * VM); the Linux-only parts of the model were verified for spawn in #161.
 *
 *   nix run nixpkgs#bun -- test tests/door-bridge-e2e.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { tmpdir } from "node:os";

import { type DoorGrant, type DoorTransport, type IssuerKeys, signGrant, tcp, unix } from "../guest-room/mod.ts";
import { call, createDoorHandlers, signedGrantAuthorizer } from "../guest-room/protocol.ts";
import { type Interposer, frontDoorsWithInterposers, teardownInterposers } from "../door-interpose.ts";

const noop = (): void => {};

// One issuer keypair (the concierge's, in production); the door verifies against
// its published public key, keyless.
const kp = generateKeyPairSync("ed25519");
const pem = kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const sign = (d: string): string => edSign(null, Buffer.from(d), kp.privateKey).toString("base64");
const verifyWith = (data: string, signature: string, publicKeyPem: string): boolean =>
  edVerify(null, Buffer.from(data), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
const keys: IssuerKeys = { keys: [{ kid: "k1", publicKeyPem: pem }] };

const scoutDoor = (host: DoorTransport): DoorGrant => ({
  name: "scout",
  host,
  guest: unix("/run/doors/scoutd.sock"),
  env: "SCOUTD_SOCK",
  grants: "external reads",
  use: "read",
  caveats: [],
});

describe("door-bridge e2e: unix proxy → bridge → grant-gated tcp door", () => {
  const servers: Array<{ stop: () => void }> = [];
  const paths: string[] = [];
  const live: Interposer[] = [];
  afterEach(() => {
    teardownInterposers(live);
    live.length = 0;
    for (const s of servers.splice(0)) s.stop();
    paths.splice(0);
  });

  /** A REAL grant-gated tcp scout door (the scoutd pattern: signedGrantAuthorizer
   *  for THIS room + door). Returns its ephemeral port. */
  function gatedTcpScout(audience = "room-A"): number {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: createDoorHandlers(
        "scout",
        { status: () => ({ ok: true }) },
        noop,
        signedGrantAuthorizer({ keys, audience, verifyWith, door: "scout" }),
      ),
    });
    servers.push(server);
    return server.port;
  }

  function front(door: DoorGrant, launchId: string, grantFor: () => ReturnType<typeof signGrant> | undefined): string {
    const { doors, interposers } = frontDoorsWithInterposers([door], launchId, { grantFor, socketDir: tmpdir() });
    live.push(...interposers);
    paths.push(...interposers.map((i) => i.socketPath));
    expect(doors[0]!.host.kind).toBe("unix"); // the box faces a unix socket, never tcp
    return (doors[0]!.host as { path: string }).path;
  }

  test("a valid scout grant carried by the bridge is ACCEPTED by the tcp gate", async () => {
    const door = scoutDoor(tcp("127.0.0.1", gatedTcpScout()));
    const grant = signGrant(door, { audience: "room-A", exp: Date.now() + 60_000, nonce: "n1", keyId: "k1" }, sign);
    const proxy = front(door, "e2e-ok", () => grant);
    // The box spoke unix; the bridge carried the grant to the tcp door's gate.
    expect(await call(proxy, "status", {})).toEqual({ ok: true });
  });

  test("NO grant is rejected by the tcp gate — surfaced through the bridge (fail closed)", async () => {
    const door = scoutDoor(tcp("127.0.0.1", gatedTcpScout()));
    const proxy = front(door, "e2e-nogrant", () => undefined);
    await expect(call(proxy, "status", {})).rejects.toThrow();
  });

  test("a grant for ANOTHER room is rejected — the audience binding holds across the bridge", async () => {
    const door = scoutDoor(tcp("127.0.0.1", gatedTcpScout("room-A")));
    const wrong = signGrant(door, { audience: "room-B", exp: Date.now() + 60_000, nonce: "n2", keyId: "k1" }, sign);
    const proxy = front(door, "e2e-wrongroom", () => wrong);
    await expect(call(proxy, "status", {})).rejects.toThrow();
  });
});
