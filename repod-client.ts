#!/usr/bin/env bun
/**
 * repod-client — the ONLY way claude-room touches repo content when launched
 * with --repo-door: ask repod (over the pod-shared unix socket) to prepare a
 * checkout, print the resulting path on success. No git, no .git, no bind-
 * mount of the real repo ever reaches this process — see repod.ts.
 *
 * Usage: repod-client <socketPath> <ref>
 * Prints the checkout path to stdout and exits 0 on success; prints the
 * error to stderr and exits 1 on failure.
 */
export {};

const [socketPath, ref] = Bun.argv.slice(2);
if (!socketPath || !ref) {
  console.error("usage: repod-client <socketPath> <ref>");
  process.exit(1);
}

const response: string = await new Promise((resolvePromise, reject) => {
  let buffer = "";
  Bun.connect({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.write(`${JSON.stringify({ op: "prepare", ref })}\n`);
      },
      data(_socket, chunk) {
        buffer += chunk.toString();
      },
      close() {
        resolvePromise(buffer);
      },
      error(_socket, err) {
        reject(err);
      },
    },
  });
});

let parsed: { ok: boolean; path?: string; error?: string };
try {
  parsed = JSON.parse(response.trim());
} catch {
  console.error(`repod-client: malformed response: ${response}`);
  process.exit(1);
}
if (!parsed.ok) {
  console.error(`repod-client: ${parsed.error}`);
  process.exit(1);
}
console.log(parsed.path);
