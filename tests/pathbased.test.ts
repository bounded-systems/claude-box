// pathbased's method handlers — a broker over the host's own `path` binary
// (PATHBASED_BIN overrides which binary to exec). Each test installs a tiny
// fake `path` script so no real Pathbase session/network is needed.
//
//   nix run nixpkgs#bun -- test tests/pathbased.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleStatus,
  handleWhoami,
  handleExport,
  handleImport,
  handleRequest,
  parseWhoami,
} from "../pathbased.ts";

let fakeDir: string;
let savedBin: string | undefined;

function installFakePath(script: string): void {
  const file = join(fakeDir, "path");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  process.env.PATHBASED_BIN = file;
}

beforeEach(() => {
  fakeDir = mkdtempSync(join(tmpdir(), "pathbased-test-"));
  savedBin = process.env.PATHBASED_BIN;
});

afterEach(() => {
  rmSync(fakeDir, { recursive: true, force: true });
  if (savedBin === undefined) delete process.env.PATHBASED_BIN;
  else process.env.PATHBASED_BIN = savedBin;
});

describe("parseWhoami", () => {
  test("parses user, id, email, server", () => {
    const out = "alex (u-123)\nemail: alex@example.com\nserver: https://pathbase.dev\n";
    expect(parseWhoami(out)).toEqual({
      user: "alex",
      id: "u-123",
      email: "alex@example.com",
      server: "https://pathbase.dev",
    });
  });

  test("parses without an email line", () => {
    const out = "alex (u-123)\nserver: https://pathbase.dev\n";
    expect(parseWhoami(out)).toEqual({ user: "alex", id: "u-123", server: "https://pathbase.dev" });
  });

  test("degrades gracefully on unrecognized output (raw always survives upstream)", () => {
    expect(parseWhoami("some future format\n")).toEqual({});
  });
});

describe("handleStatus", () => {
  test("reports loggedIn true when whoami exits 0", async () => {
    installFakePath("#!/bin/sh\necho 'alex (u-123)'\necho 'server: https://pathbase.dev'\nexit 0\n");
    const result = await handleStatus({}) as { loggedIn: boolean; version: string };
    expect(result.loggedIn).toBe(true);
    expect(result.version).toBe("0.1.0");
  });

  test("reports loggedIn false when whoami exits non-zero", async () => {
    installFakePath("#!/bin/sh\nexit 1\n");
    const result = await handleStatus({}) as { loggedIn: boolean };
    expect(result.loggedIn).toBe(false);
  });
});

describe("handleWhoami", () => {
  test("returns the parsed identity on success", async () => {
    installFakePath("#!/bin/sh\necho 'alex (u-123)'\necho 'server: https://pathbase.dev'\nexit 0\n");
    const result = await handleWhoami({});
    expect(result).toEqual({
      raw: "alex (u-123)\nserver: https://pathbase.dev",
      user: "alex",
      id: "u-123",
      server: "https://pathbase.dev",
    });
  });

  test("throws NOT_LOGGED_IN on a non-zero exit", async () => {
    installFakePath("#!/bin/sh\necho 'Error: Not logged in. Run \\`path auth login\\`.' >&2\nexit 1\n");
    await expect(handleWhoami({})).rejects.toMatchObject({ code: "NOT_LOGGED_IN" });
  });
});

describe("handleExport", () => {
  test("stages the document to a temp file (--input) and returns the printed URL", async () => {
    installFakePath(
      `#!/bin/sh\n` +
        `if [ "$1" = "p" ] && [ "$2" = "export" ] && [ "$3" = "pathbase" ] && [ "$4" = "--input" ]; then\n` +
        `  cat "$5" > "${fakeDir}/captured.json"\n` +
        `  echo "https://pathbase.dev/alex/repo/path-abc"\n` +
        `  exit 0\n` +
        `fi\n` +
        `exit 1\n`,
    );
    const document = { graph: { id: "g1" }, paths: [] };
    const result = await handleExport({ document });
    expect(result).toEqual({ url: "https://pathbase.dev/alex/repo/path-abc" });
    expect(JSON.parse(readFileSync(join(fakeDir, "captured.json"), "utf8"))).toEqual(document);
  });

  test("rejects a missing document", async () => {
    await expect(handleExport({})).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  test("surfaces a non-zero exit as EXPORT_FAILED, carrying stderr", async () => {
    installFakePath("#!/bin/sh\necho 'boom' >&2\nexit 1\n");
    await expect(handleExport({ document: {} })).rejects.toMatchObject({ code: "EXPORT_FAILED", message: "boom" });
  });

  test("forwards optional repo/name/public/url as extra flags", async () => {
    installFakePath(`#!/bin/sh\necho "$@" > "${fakeDir}/argv.txt"\necho "https://pathbase.dev/x"\nexit 0\n`);
    await handleExport({ document: {}, repo: "alex/pathstash", name: "my-pr", public: true, url: "https://x.dev" });
    const argv = readFileSync(join(fakeDir, "argv.txt"), "utf8");
    expect(argv).toContain("--repo alex/pathstash");
    expect(argv).toContain("--name my-pr");
    expect(argv).toContain("--public");
    expect(argv).toContain("--url https://x.dev");
  });
});

describe("handleImport", () => {
  test("returns the parsed document JSON printed by --no-cache", async () => {
    installFakePath(
      `#!/bin/sh\n` +
        `if [ "$1" = "p" ] && [ "$2" = "import" ] && [ "$3" = "pathbase" ]; then\n` +
        `  echo '{"graph":{"id":"g1"},"paths":[]}'\n` +
        `  exit 0\n` +
        `fi\n` +
        `exit 1\n`,
    );
    const result = await handleImport({ ref: "alex/repo/path-abc" });
    expect(result).toEqual({ document: { graph: { id: "g1" }, paths: [] } });
  });

  test("rejects a missing ref", async () => {
    await expect(handleImport({})).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  test("surfaces a non-zero exit as IMPORT_FAILED", async () => {
    installFakePath("#!/bin/sh\necho 'not found' >&2\nexit 1\n");
    await expect(handleImport({ ref: "x" })).rejects.toMatchObject({ code: "IMPORT_FAILED" });
  });

  test("surfaces non-JSON stdout as PARSE_ERROR", async () => {
    installFakePath("#!/bin/sh\necho 'not json'\nexit 0\n");
    await expect(handleImport({ ref: "x" })).rejects.toMatchObject({ code: "PARSE_ERROR" });
  });
});

describe("handleRequest (the NDJSON envelope end-to-end)", () => {
  test("dispatches whoami and wraps the result in an ok envelope", async () => {
    installFakePath("#!/bin/sh\necho 'alex (u-123)'\necho 'server: https://pathbase.dev'\nexit 0\n");
    const resp = await handleRequest(JSON.stringify({ id: "1", method: "whoami" }));
    expect(resp.ok).toBe(true);
    expect((resp.result as { user?: string }).user).toBe("alex");
  });

  test("an unknown method is rejected without reaching any handler", async () => {
    const resp = await handleRequest(JSON.stringify({ id: "1", method: "bogus" }));
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("UNKNOWN_METHOD");
  });

  test("invalid JSON is a parse error, not a crash", async () => {
    const resp = await handleRequest("not json");
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("PARSE_ERROR");
  });
});
