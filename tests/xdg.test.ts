/**
 * XDG one-path drift pin. The in-box config dir is declared in TWO places — the
 * image (flake.nix: XDG_CONFIG_HOME → configDir → CLAUDE_CONFIG_DIR + the volume
 * declaration) and the launcher (claude-box.ts: BOX_CONFIG_DIR, used for the
 * `-v …:U` mount). If they drift, `claude auth login` (incl. --remote-control's
 * full-scope login) would persist to a path the volume doesn't capture. These
 * tests resolve the flake's XDG chain and pin it to BOX_CONFIG_DIR so the two
 * sides stay one path.
 *
 *   nix run nixpkgs#bun -- test tests/xdg.test.ts
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { BOX_CONFIG_DIR } from "../claude-box.ts";

const flake = readFileSync(new URL("../flake.nix", import.meta.url), "utf8");

/** Pull `name = "value";` from the flake's let-bindings and resolve the simple
 *  `${ref}` interpolations we use (user → home → xdgConfigHome → configDir). */
function nixLet(name: string): string {
  const m = flake.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  if (!m) throw new Error(`flake.nix: no let-binding ${name}`);
  return m[1]!;
}
function resolveChain(): string {
  const user = nixLet("user");
  const home = nixLet("home").replace("${user}", user);
  const xdgConfigHome = nixLet("xdgConfigHome").replace("${home}", home);
  const configDir = nixLet("configDir").replace("${xdgConfigHome}", xdgConfigHome);
  return configDir;
}

describe("XDG one config path", () => {
  test("flake configDir derives from xdgConfigHome (not a hardcoded .config)", () => {
    expect(nixLet("configDir")).toContain("${xdgConfigHome}");
    expect(nixLet("xdgConfigHome")).toContain("${home}");
  });

  test("the image exports XDG_CONFIG_HOME and derives CLAUDE_CONFIG_DIR from configDir", () => {
    expect(flake).toContain('"XDG_CONFIG_HOME=${xdgConfigHome}"');
    expect(flake).toContain('"CLAUDE_CONFIG_DIR=${configDir}"');
  });

  test("launcher BOX_CONFIG_DIR equals the flake's resolved configDir (no drift)", () => {
    expect(BOX_CONFIG_DIR).toBe(resolveChain());
  });

  test("the one path is the XDG location ($XDG_CONFIG_HOME/claude)", () => {
    expect(BOX_CONFIG_DIR).toBe("/home/claude/.config/claude");
  });
});
