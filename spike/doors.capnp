# doors.capnp — capability-RPC schema for the claude-box door fleet (SPIKE).
#
# WHAT THIS REPLACES
#   The hand-rolled `RequestEnvelope = {id, method, params}` JSON, currently
#   duplicated verbatim across lib/keeper.ts:123, lib/scout.ts:174,
#   lib/spawn.ts:122 (and mirrored daemon-side). `method` is a free string;
#   `params`/`result` are `Record<string, unknown>` — i.e. unchecked at the wire.
#
# WHAT IT BUYS (mapped to DOORS.md / CAPABILITIES.md)
#   1. Each door is an *interface* = a capability. You cannot invoke a method
#      you don't hold a reference to — "Capability = dispatch to a guest"
#      (DOORS.md:40) expressed in the type system, not by convention.
#   2. Typed ops + payloads: no string `method`, no `unknown` params. One schema,
#      not three copies.
#   3. Capabilities ride *inside* messages (Cap'n Proto level-3 RPC). That is the
#      lever for the gap CAPABILITIES.md:129-156 admits: in TCP mode possession
#      degrades to "ambient host-local reachability… no possession-semantics."
#      A returned interface reference IS possession — see Launcher.launch / Box.
#   4. Attenuation/delegation become typed methods (Scout.attenuate, Net.attenuate)
#      — POLA narrowing that ad-hoc JSON can't express.
#
# Regenerate the file id with `capnp id` before any real use — the one below is a
# placeholder of the right shape (16 hex, high bit set).
@0xb8f9a1c2d3e4f506;

# ═════════════════════════════════════════════════════════════════════════════
# keeperd — signed git writes. Owns the Ed25519 key; the box holds none.
#   client: lib/keeper.ts  ops: commit push sign verify status getPublicKey
# ═════════════════════════════════════════════════════════════════════════════
interface Keeper {
  commit       @0 (req :CommitRequest) -> (res :CommitResult);
  push         @1 (req :PushRequest)   -> (res :PushResult);
  sign         @2 (data :Data)         -> (res :SignResult);
  verify       @3 (req :VerifyRequest) -> (res :VerifyResult);
  status       @4 ()                   -> (res :KeeperStatus);
  getPublicKey @5 ()                   -> (publicKey :Text, keyId :Text);
}

struct CommitRequest {
  repo    @0 :Text;          # in-box path (/work); keeperd translates to host path
  message @1 :Text;
  author  @2 :Text;          # "" ⇒ keeperd's default identity
  files   @3 :List(Text);
  all     @4 :Bool;
  amend   @5 :Bool;
}
struct CommitResult {
  commit      @0 :Text;
  attestation @1 :Attestation;   # null pointer ⇒ signing disabled
}
struct Attestation {
  statementDigest @0 :Text;
  signature       @1 :Text;
  keyId           @2 :Text;
  statement       @3 :Data;      # opaque in-toto statement (JSON bytes)
}
struct PushRequest {
  repo        @0 :Text;
  remote      @1 :Text;      # "" ⇒ origin
  branch      @2 :Text;      # "" ⇒ current branch
  force       @3 :Bool;
  setUpstream @4 :Bool;
}
struct PushResult {
  pushed  @0 :Text;
  commits @1 :List(Text);
}
struct SignResult   { signature @0 :Text; keyId @1 :Text; }
struct VerifyRequest { data @0 :Data; signature @1 :Text; publicKey @2 :Text; }
struct VerifyResult  { valid @0 :Bool; keyId @1 :Text; }
struct KeeperStatus {
  version @0 :Text;
  uptime  @1 :UInt64;
  signing :group { enabled @2 :Bool; keyId @3 :Text; }
}

# ═════════════════════════════════════════════════════════════════════════════
# scoutd — credential-free external reads. Returns CONTENT, never a token.
#   client: lib/scout.ts  ops: repo pr issue fetch download status
# ═════════════════════════════════════════════════════════════════════════════
interface Scout {
  repo     @0 (req :RepoRequest)  -> (res :RepoResult);
  pr       @1 (req :PrRequest)    -> (res :PrResult);
  issue    @2 (req :IssueRequest) -> (res :IssueResult);
  fetch    @3 (req :FetchRequest) -> (res :FetchResult);
  download @4 (req :FetchRequest) -> (res :DownloadResult);
  status   @5 ()                  -> (res :ScoutStatus);

  # ── the ocap move ad-hoc JSON cannot express ──
  # Hand back a *narrower* scout: same door, attenuated allowlist. A holder can
  # delegate this to a sub-task that may read strictly less. (POLA / attenuation.)
  attenuate @6 (allow :List(Text)) -> (scout :Scout);
}

struct RepoRequest { url @0 :Text; ref @1 :Text; }       # ref "" ⇒ HEAD
struct RepoResult {
  owner         @0 :Text;
  repo          @1 :Text;
  ref           @2 :Text;
  defaultBranch @3 :Text;
  description   @4 :Text;
  tarballUrl    @5 :Text;
}
struct PrRequest { repo @0 :Text; number @1 :UInt32; diff @2 :Bool; comments @3 :Bool; }
struct PrResult {
  number       @0 :UInt32;
  title        @1 :Text;
  body         @2 :Text;
  state        @3 :Text;
  user         @4 :Text;
  head         @5 :GitRef;
  base         @6 :GitRef;
  createdAt    @7 :Text;
  updatedAt    @8 :Text;
  additions    @9 :UInt32;
  deletions    @10 :UInt32;
  changedFiles @11 :UInt32;
  diff         @12 :Text;             # "" unless requested
  comments     @13 :List(ReviewComment);
}
struct GitRef       { ref @0 :Text; sha @1 :Text; }
struct ReviewComment { user @0 :Text; body @1 :Text; path @2 :Text; createdAt @3 :Text; }
struct IssueRequest { repo @0 :Text; number @1 :UInt32; comments @2 :Bool; }
struct IssueResult {
  number    @0 :UInt32;
  title     @1 :Text;
  body      @2 :Text;
  state     @3 :Text;
  user      @4 :Text;
  labels    @5 :List(Text);
  createdAt @6 :Text;
  updatedAt @7 :Text;
  comments  @8 :List(IssueComment);
}
struct IssueComment { user @0 :Text; body @1 :Text; createdAt @2 :Text; }
struct FetchRequest { url @0 :Text; binary @1 :Bool; maxSize @2 :UInt64; }
struct FetchResult {
  url         @0 :Text;
  status      @1 :UInt32;
  contentType @2 :Text;
  size        @3 :UInt64;
  body        @4 :Text;
}
struct DownloadResult {
  url         @0 :Text;
  size        @1 :UInt64;
  contentType @2 :Text;
  sha256      @3 :Text;
  data        @4 :Data;      # binary bytes, not base64 — capnp carries Data natively
}
struct ScoutStatus {
  version   @0 :Text;
  uptime    @1 :UInt64;
  hasToken  @2 :Bool;
  allowlist @3 :List(Text);
}

# ═════════════════════════════════════════════════════════════════════════════
# launcherd — spawn sub-boxes. Owns podman; the box holds no runtime.
#   client: lib/spawn.ts  ops: launch status list kill attach rooms
# ═════════════════════════════════════════════════════════════════════════════
interface Launcher {
  # launch returns a Box capability AND capabilities to exactly the granted
  # doors — the box holds NO others. "No ambient authority; delegated by
  # dispatch" (DOORS.md:43) as a *return type*. And it kills the bearer-string
  # gap: the caller holds a `Box`, not a forgeable launchId.
  launch @0 (opts :SpawnOptions) -> (box :Box, grants :Grants, attestation :Attestation);
  status @1 ()              -> (res :LauncherStatus);
  list   @2 (account :Text) -> (launches :List(BoxInfo));
  rooms  @3 ()              -> (rooms :List(RoomEntry));
}

# A handle to a spawned box. kill/attach move from launchId-keyed methods to
# methods *on the capability* — possession is the authority (cf. lib/spawn.ts
# kill(launchId) / attach(launchId), which trust a forgeable string today).
interface Box {
  kill   @0 (signal :Text) -> (killed :Bool);
  attach @1 ()             -> (stdout :Text, stderr :Text, exitCode :Int32);
  info   @2 ()             -> (info :BoxInfo);
}

struct Grants {
  # null field ⇒ not granted. The set of non-null caps IS the room.
  keeper @0 :Keeper;
  scout  @1 :Scout;
  net    @2 :Net;
}

# netd is a transport proxy (squid) today, not a JSON door — modeled here so the
# Grants bundle is complete and to show egress is attenuable too.
interface Net {
  attenuate @0 (allow :List(Text)) -> (net :Net);   # narrow to a sub-allowlist
  status    @1 () -> (allowlist :List(Text));
}

struct SpawnOptions {
  account    @0 :Text;       # "" ⇒ "personal"
  room       @1 :Text;       # e.g. "dev", "readonly"
  repo       @2 :Text;       # host path to mount; "" ⇒ none
  repoRw     @3 :Bool;       # .git writable (unsafe)
  doors      @4 :List(Text); # explicit door grants (alternative to a room)
  netOpen    @5 :Bool;       # ambient egress, no allowlist (unsafe)
  claudeArgs @6 :List(Text);
  depth      @7 :UInt32;     # auto-incremented from the spawning box
}
struct BoxInfo {
  launchId  @0 :Text;
  account   @1 :Text;
  pid       @2 :Int32;
  startedAt @3 :Text;
  doors     @4 :List(Text);
  repo      @5 :Text;
  depth     @6 :UInt32;
  status    @7 :Status;
  enum Status { running @0; exited @1; }
}
struct RoomEntry { name @0 :Text; description @1 :Text; }
struct LauncherStatus {
  version  @0 :Text;
  uptime   @1 :UInt64;
  launches @2 :UInt32;
  signing :group { enabled @3 :Bool; keyId @4 :Text; }
  policy :group {
    enabled       @5 :Bool;
    defaultAllow  @6 :List(Text);
    rulesCount    @7 :UInt32;
    maxConcurrent @8 :Int32;        # -1 ⇒ unlimited
    maxDepth      @9 :UInt32;
  }
  doors @10 :List(DoorEntry);       # capnp has no map; entries instead
  rooms @11 :List(RoomEntry);
}
struct DoorEntry { name @0 :Text; socket @1 :Text; reachable @2 :Bool; }
