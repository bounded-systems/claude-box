/**
 * verbspec — author a command ONCE, project it everywhere (ported from prx's
 * spike at packages/prx/src/cli/verbspec.ts, minus the Zod dependency: this
 * repo ships zero npm packages by design — everything is bun/node builtins —
 * so params are a small hand-rolled shape instead of a Zod schema).
 *
 * The insight this session landed on: a claude-box DOOR already has exactly
 * the shape a verb wants — a name, a param contract, a one-line description
 * of what it's for (`use`). So a door's client script (bellhop.ts) can be
 * authored as a VerbSpec, and the SAME spec projects to both its own
 * `--help`/argv parsing AND the Claude Code slash-command markdown that
 * invokes it — no drift between what the command does and what the box
 * tells the model it does.
 *
 *   VerbSpec (this file's canonical shape)
 *     ├─ parseArgs   ──▶ argv → validated input (positionals + --flags)
 *     ├─ toHelp      ──▶ --help text
 *     └─ toClaudeCommand ──▶ .claude/commands/<id>.md (frontmatter + body)
 */

export type ParamSpec = {
  type: "string";
  required?: boolean;
  description?: string;
};

export type VerbSpec<I extends Record<string, string> = Record<string, string>> = {
  /** Stable verb id — the CLI subcommand and the Claude Code slash-command name. */
  id: string;
  summary: string;
  /** Positional-only params, in the order they're read off argv (this repo's
   *  doors/verbs are all small positional calls — no --flags needed yet). */
  params: Record<string, ParamSpec>;
  positionals: readonly string[];
  run: (input: I) => Promise<unknown> | unknown;
};

/** Identity helper (mirrors prx's defineVerb) — no-op at runtime, but gives
 *  call sites inference without an explicit type annotation. */
export function defineVerb<I extends Record<string, string>>(spec: VerbSpec<I>): VerbSpec<I> {
  return spec;
}

/** Parse argv into the verb's input by positional order. CLI-isms (missing
 *  required args) are reported as a plain Error — no schema library needed
 *  for a shape this small. */
export function parseArgs<I extends Record<string, string>>(
  v: VerbSpec<I>,
  argv: readonly string[],
): I {
  const raw: Record<string, string> = {};
  v.positionals.forEach((name, idx) => {
    if (argv[idx] !== undefined) raw[name] = argv[idx]!;
  });
  for (const name of v.positionals) {
    if (v.params[name]?.required && raw[name] === undefined) {
      throw new Error(`missing required argument: ${name}`);
    }
  }
  return raw as I;
}

export function toHelp<I extends Record<string, string>>(v: VerbSpec<I>): string {
  const usage = v.positionals
    .map((p) => (v.params[p]?.required ? `<${p}>` : `[${p}]`))
    .join(" ");
  const lines = [`${v.id} ${usage}`.trimEnd(), "", `  ${v.summary}`, ""];
  if (v.positionals.length) {
    lines.push("Arguments:");
    for (const p of v.positionals) {
      const meta = v.params[p];
      const req = meta?.required ? " (required)" : "";
      const desc = meta?.description ? ` — ${meta.description}` : "";
      lines.push(`  ${p}${req}${desc}`);
    }
  }
  return lines.join("\n");
}

/** Project a verb to a Claude Code custom slash-command file
 *  (`.claude/commands/<id>.md`): YAML frontmatter (description + an
 *  argument-hint built from the SAME positionals used for real argv
 *  parsing, so the two can't drift) and a body that runs the verb's own
 *  script via the model's Bash tool, passing `$ARGUMENTS` straight through
 *  (this file's own parseArgs — not the model — is what validates them). */
export function toClaudeCommand<I extends Record<string, string>>(v: VerbSpec<I>, opts: { scriptPath: string; runtime?: string }): string {
  const runtime = opts.runtime ?? "bun";
  const argumentHint = v.positionals
    .map((p) => (v.params[p]?.required ? `<${p}>` : `[${p}]`))
    .join(" ");
  return `---
description: ${v.summary}
argument-hint: ${argumentHint}
---

Run \`${runtime} ${opts.scriptPath} $ARGUMENTS\` and report back exactly what it prints: the checkout path on success, or the error message on failure. Do not attempt this any other way — ${v.id} is the ONLY sanctioned path to this capability.
`;
}
