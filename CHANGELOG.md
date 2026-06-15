# Changelog

## [0.4.0](https://github.com/bounded-systems/claude-box/compare/claude-box-v0.3.0...claude-box-v0.4.0) (2026-06-15)


### Features

* **guest-room:** bump pin to attenuatesDoors engine + sync mirror ([#103](https://github.com/bounded-systems/claude-box/issues/103)) ([2e7bf97](https://github.com/bounded-systems/claude-box/commit/2e7bf97f49e91275b3743a1fae373cd9281a7932))
* **launcherd:** enforce caveat-aware room attenuation via attenuatesDoors ([#107](https://github.com/bounded-systems/claude-box/issues/107)) ([821e0d1](https://github.com/bounded-systems/claude-box/commit/821e0d195ebc5571baf060b0a8cc3444b66bb0c4))


### Bug Fixes

* **ci:** read release version from latest main, not the trigger commit ([#102](https://github.com/bounded-systems/claude-box/issues/102)) ([ce42e1e](https://github.com/bounded-systems/claude-box/commit/ce42e1e5fb617cf53229060ab9ae257c6342d6d5))

## [0.3.0](https://github.com/bounded-systems/claude-box/compare/claude-box-v0.2.0...claude-box-v0.3.0) (2026-06-15)


### Features

* **guest-room:** bump pin to checkCaveats engine + sync mirror ([#96](https://github.com/bounded-systems/claude-box/issues/96)) ([2ac316e](https://github.com/bounded-systems/claude-box/commit/2ac316e6498daf0d28dae87c06235f6374c53220))
* **guest-room:** consume the published engine as a pinned flake input ([#93](https://github.com/bounded-systems/claude-box/issues/93)) ([fb0d7ca](https://github.com/bounded-systems/claude-box/commit/fb0d7cabc71cf677adb09149095645e9eb7bced3))
* **nix:** self-verifying doors module + app meta (nix flake check clean) ([#85](https://github.com/bounded-systems/claude-box/issues/85)) ([a1e65b7](https://github.com/bounded-systems/claude-box/commit/a1e65b7a89c5d61c0422df04b6a53e6da483f533))
* **remote-control:** --remote-serve — boot the box into RC server mode (prx-v9wn) ([#94](https://github.com/bounded-systems/claude-box/issues/94)) ([024d4c4](https://github.com/bounded-systems/claude-box/commit/024d4c490d1ab706f1ab819c4dace933df9cddeb))
* **scoutd:** enforce egress allowlist through guest-room checkCaveats ([#99](https://github.com/bounded-systems/claude-box/issues/99)) ([e786445](https://github.com/bounded-systems/claude-box/commit/e786445b120713ad558adb941689752539cbd6e1))
* **scoutd:** force scout egress through a dedicated scout-netd (no NIC) ([#92](https://github.com/bounded-systems/claude-box/issues/92)) ([489118a](https://github.com/bounded-systems/claude-box/commit/489118a4c5cd7aed29bca0fb98cae40c7acf055c))
* **scoutd:** make egress proxy-capable (plumbing, not a boundary change) ([#90](https://github.com/bounded-systems/claude-box/issues/90)) ([1adecc3](https://github.com/bounded-systems/claude-box/commit/1adecc384c34476b142572d60fc1ffdf9c4f07fd))


### Bug Fixes

* **guest-room:** remove duplicate stale attenuate() export ([#91](https://github.com/bounded-systems/claude-box/issues/91)) ([9a3a4f4](https://github.com/bounded-systems/claude-box/commit/9a3a4f4d854357e2034301e1b34edabcc20e8a3d))
* **remote-control:** keep nonessential traffic blocked at source under RC ([#98](https://github.com/bounded-systems/claude-box/issues/98)) ([81b31da](https://github.com/bounded-systems/claude-box/commit/81b31da3bb37fedab38627053ec32b7c10c9e254))
* resolve all tsc --noEmit type errors and gate tsc in CI ([#87](https://github.com/bounded-systems/claude-box/issues/87)) ([5834353](https://github.com/bounded-systems/claude-box/commit/58343538ab66906a215c86ea689d08ee295acdb0))

## [0.2.0](https://github.com/bounded-systems/claude-box/compare/claude-box-v0.1.1...claude-box-v0.2.0) (2026-06-15)


### Features

* **nixos:** run the door daemons via a NixOS module ([#83](https://github.com/bounded-systems/claude-box/issues/83)) ([811414b](https://github.com/bounded-systems/claude-box/commit/811414b0c913986d15c2715eae6f6521d9c73e83))

## [0.1.1](https://github.com/bounded-systems/claude-box/compare/claude-box-v0.1.0...claude-box-v0.1.1) (2026-06-15)


### Bug Fixes

* **ci:** pass release version from version.txt and rename GHCR images to room/doors ([#81](https://github.com/bounded-systems/claude-box/issues/81)) ([968d957](https://github.com/bounded-systems/claude-box/commit/968d957d1773ee4a5f2b892131697081d13c1073))

## [0.1.0](https://github.com/bounded-systems/claude-box/compare/claude-box-v0.1.0...claude-box-v0.1.0) (2026-06-15)


### Features

* **auth:** forward CLAUDE_CODE_OAUTH_TOKEN into the box (headless login) ([#49](https://github.com/bounded-systems/claude-box/issues/49)) ([185dfbc](https://github.com/bounded-systems/claude-box/commit/185dfbcfe5518a6a9e43b90d2e7983182f29a25c))
* bake prx into the image (pinned v0.8.4 aarch64-linux) ([fe3644e](https://github.com/bounded-systems/claude-box/commit/fe3644e4d90f93add51341724e2eefc4169df025))
* **box:** OCAP capability surface — doors, generic --door, honest per-launch manifest ([#1](https://github.com/bounded-systems/claude-box/issues/1)) ([6183dd3](https://github.com/bounded-systems/claude-box/commit/6183dd3c406810837fb9bb0164cc0f6243864dbb))
* bump pinned prx to v0.10.0 (lands prx-ag7 in the box) ([d675eec](https://github.com/bounded-systems/claude-box/commit/d675eecc56ce5e70489de8fde9e20513fac07cc6))
* claude-box — pinned, isolated, multi-account Claude runtime ([8a71367](https://github.com/bounded-systems/claude-box/commit/8a713675bcba7f8bc7bbc79a022a2b1f2b8560e6))
* **claude-box:** --repo &lt;path&gt; — mount a worktree to work on a repo ([bb690cc](https://github.com/bounded-systems/claude-box/commit/bb690ccb94c1350fe597d29d2ed7c5ff9eb2922e))
* **doctor:** flag running boxes pinned to a stale image ([#38](https://github.com/bounded-systems/claude-box/issues/38)) ([20f0b28](https://github.com/bounded-systems/claude-box/commit/20f0b28f2751a9cc9c1bdb4974529dd8f7477410))
* egress is a door (--net) + box hardening floor ([#3](https://github.com/bounded-systems/claude-box/issues/3)) ([e7d5388](https://github.com/bounded-systems/claude-box/commit/e7d538810f1a5dfee9abe8c6394c71f49715318a))
* **flake:** one-call `nix run .#setup` bringup + fix darwin default ([#33](https://github.com/bounded-systems/claude-box/issues/33)) ([d7fcd9a](https://github.com/bounded-systems/claude-box/commit/d7fcd9a2807b4fdd1a13cc5b92c1757b84cdf6a3))
* implement scoutd, netd-image, ephemeral worktrees, doors command ([875d602](https://github.com/bounded-systems/claude-box/commit/875d602f3f08da62b7b47ba7bd6c1cc83c133be0))
* improve install/build experience ([ebf5620](https://github.com/bounded-systems/claude-box/commit/ebf56201d30a0f09930daa201d49335e0df95dba))
* **keeper:** auto-translate /work paths ([#23](https://github.com/bounded-systems/claude-box/issues/23)) ([7caa7bb](https://github.com/bounded-systems/claude-box/commit/7caa7bb8b4462fd26a46b720bd5a8c0137e98231))
* **keeperd:** git-signing daemon with L3 attestation ([#22](https://github.com/bounded-systems/claude-box/issues/22)) ([59c70a5](https://github.com/bounded-systems/claude-box/commit/59c70a5559cd8d4d9bdb799d96954fbc13f99ba3))
* land launcherd + keeperd daemons and SLSA Provenance v1 ([#20](https://github.com/bounded-systems/claude-box/issues/20)) ([1e74f99](https://github.com/bounded-systems/claude-box/commit/1e74f9999be700d79863e0362edb87350cbf90d5))
* **launch:** preflight TCP doors so a down daemon fails fast with a hint ([#40](https://github.com/bounded-systems/claude-box/issues/40)) ([1883630](https://github.com/bounded-systems/claude-box/commit/1883630f8b28d566b57531e37c65253bafb9043b))
* **netd:** pinned bun egress daemon (nix run .#netd) + prx handoff ([#13](https://github.com/bounded-systems/claude-box/issues/13)) ([7cf63a0](https://github.com/bounded-systems/claude-box/commit/7cf63a0a24178fe9148741c5b95f23ab9ab8df32))
* **orchestration:** add Quadlet units and keeperd container image ([e1a4306](https://github.com/bounded-systems/claude-box/commit/e1a430670dbc57deba5bf47abc1e2702a9b3ff33))
* **pod:** --pod — run the box + its netd door in an isolated pod (off-host) ([#48](https://github.com/bounded-systems/claude-box/issues/48)) ([3236c3c](https://github.com/bounded-systems/claude-box/commit/3236c3c24db7a50bbabcb4bedb2a4fa4b95223c7))
* **provenance:** capability-aware provenance contract + L1 image attestation ([#2](https://github.com/bounded-systems/claude-box/issues/2)) ([b19b714](https://github.com/bounded-systems/claude-box/commit/b19b714f5e767a790d9d0e3b84cd76e8fcb635d5))
* **quadlet:** add security hardening and document schema ([91ee79c](https://github.com/bounded-systems/claude-box/commit/91ee79ce388d0338bbff0d84553d493caea432f7))
* **remote-control:** opt-in --remote-control profile (prx-z4c6) ([#74](https://github.com/bounded-systems/claude-box/issues/74)) ([e348933](https://github.com/bounded-systems/claude-box/commit/e348933616332cf3a91688027820c3d18bb43d40))
* **repo:** --repo-clone — isolated clone with in-box git (write-model step 2) ([#42](https://github.com/bounded-systems/claude-box/issues/42)) ([3a2e8e1](https://github.com/bounded-systems/claude-box/commit/3a2e8e104f553f18319428a3256475bc8f375332))
* **repo:** --repo-origin — clone-in-box from origin, zero host mount ([#43](https://github.com/bounded-systems/claude-box/issues/43)) ([33b676b](https://github.com/bounded-systems/claude-box/commit/33b676b8de149442bf69cbbd7cb016a9b342f25d))
* **repo:** --repo-origin gets a policed scoped egress door (no --net-open) ([#44](https://github.com/bounded-systems/claude-box/issues/44)) ([387250e](https://github.com/bounded-systems/claude-box/commit/387250ee51101ce53ffc662fa515e475944fc267))
* **repo:** --writable to narrow the box's writable surface to subtrees ([#41](https://github.com/bounded-systems/claude-box/issues/41)) ([b19fef1](https://github.com/bounded-systems/claude-box/commit/b19fef1bee753e7298bc061cedae33f7d8282e13))
* **repo:** split --repo-origin egress into a separate git-pull door ([#45](https://github.com/bounded-systems/claude-box/issues/45)) ([a3fbe3d](https://github.com/bounded-systems/claude-box/commit/a3fbe3dd88dc780483e4a91cb9b10a6adf05d2d0))
* **room:** named door bundles over the registry (--room dev|read) ([#15](https://github.com/bounded-systems/claude-box/issues/15)) ([47119ee](https://github.com/bounded-systems/claude-box/commit/47119ee359c267dbe6c2f5a538be51b2b97c6534))
* **scoutd:** source-agnostic token injection via env (SCOUT-POD increment 1) ([#60](https://github.com/bounded-systems/claude-box/issues/60)) ([aa662c7](https://github.com/bounded-systems/claude-box/commit/aa662c746584bc5f3368e5353d6be130ebcd4302))
* **scout:** wire the --scout read door preset + ROOM.md topology sketch ([#14](https://github.com/bounded-systems/claude-box/issues/14)) ([8f43194](https://github.com/bounded-systems/claude-box/commit/8f431941a88380c51229e276ae1035ec2304fcbc))


### Bug Fixes

* auto-create ~/.claude-box/run on macOS for door sockets ([e303627](https://github.com/bounded-systems/claude-box/commit/e303627caf789857dca5fb6d85719159e541a1fe))
* **box:** root ephemeral worktree/clone temp dirs under $HOME, not /tmp ([#73](https://github.com/bounded-systems/claude-box/issues/73)) ([b68137a](https://github.com/bounded-systems/claude-box/commit/b68137a97182cc8979bb580535fd41cbc4007ab7))
* chown HOME to the claude uid (prx-al1) — rootless runtime can write ~/.cache ([9e16e85](https://github.com/bounded-systems/claude-box/commit/9e16e8557fec1a680ff6a8c4e3b8b553088ac14e))
* **ci:** make publish-ghcr work with skopeo and resilient to GHCR timeouts ([#79](https://github.com/bounded-systems/claude-box/issues/79)) ([76a25ba](https://github.com/bounded-systems/claude-box/commit/76a25baa3bbd661d47df9741baa3db3e18f73ce4))
* clean up guest-room/[#27](https://github.com/bounded-systems/claude-box/issues/27) merge collision ([#29](https://github.com/bounded-systems/claude-box/issues/29)) ([6ed51f4](https://github.com/bounded-systems/claude-box/commit/6ed51f47223ea8a8c9de9916551757455582b1a9))
* **doors:** honest in-box guidance in TCP mode (no absent /run/doors path) ([#53](https://github.com/bounded-systems/claude-box/issues/53)) ([7530776](https://github.com/bounded-systems/claude-box/commit/7530776ec65de664363978302c53fbcb79301fb6))
* **flake:** remove duplicate packages definitions ([4d70604](https://github.com/bounded-systems/claude-box/commit/4d70604ce6cbeb38e0f00ec61dffc86840e1402d))
* **image:** disable nonessential traffic to stop the statsig flood ([#34](https://github.com/bounded-systems/claude-box/issues/34)) ([c41778b](https://github.com/bounded-systems/claude-box/commit/c41778b1435f06b0712bf848faa65e094d0ee297))
* **netd:** use ~/.claude-box/run fallback on macOS ([8712b92](https://github.com/bounded-systems/claude-box/commit/8712b9253be061034d174cad50ed129057d826b8))
* **ocap-test:** gate door tiers on live daemon, not mere volume existence ([#64](https://github.com/bounded-systems/claude-box/issues/64)) ([23bee25](https://github.com/bounded-systems/claude-box/commit/23bee2565102dbaf7885a85d1c47e4cae3a902c6))
* **quadlet:** add install script, fix volume naming ([9cec4da](https://github.com/bounded-systems/claude-box/commit/9cec4da1a606e0956a8193308e39cc1ad1af9812))
* **redteam:** capture netd on an ephemeral port, never the shared 3128 ([#46](https://github.com/bounded-systems/claude-box/issues/46)) ([e70bb87](https://github.com/bounded-systems/claude-box/commit/e70bb87193ee331065f2a7a7b11990aeea68c369))
* **redteam:** drive the repo's own claude-box source, not the installed binary ([#50](https://github.com/bounded-systems/claude-box/issues/50)) ([baaef34](https://github.com/bounded-systems/claude-box/commit/baaef34806e67e7a58e145f2a68753b718ae4c11))
* **redteam:** root box-mounted temp dirs under $HOME, not /tmp ([#68](https://github.com/bounded-systems/claude-box/issues/68)) ([e7e2797](https://github.com/bounded-systems/claude-box/commit/e7e27971c2d5de64e1ed8133ac25609ce9390b78))
* **repo-origin:** clone-in-box fails fast instead of hanging on a cred prompt ([#58](https://github.com/bounded-systems/claude-box/issues/58)) ([8ae5fda](https://github.com/bounded-systems/claude-box/commit/8ae5fdaa1d289c1d06e61775268a842b67e59758))
* run prx via nix glibc loader, not autoPatchelf (don't corrupt the bun blob) ([b0f69a2](https://github.com/bounded-systems/claude-box/commit/b0f69a2c2271c9651a9a5dcbc5a7ea4137b5e6ea))


### Continuous Integration

* adopt conventional commits and seed the first release ([#78](https://github.com/bounded-systems/claude-box/issues/78)) ([97601f4](https://github.com/bounded-systems/claude-box/commit/97601f44d330aa11abd2d2cf55c9dce71a74b01f))
