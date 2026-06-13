// gherkin.ts — a tiny Gherkin-subset runner.
//
// The point: the .feature files in ./features are not prose ABOUT the engine —
// they EXECUTE against it (guest-room/mod.ts), as steps wired in the test file.
// So the documentation originates from the code and cannot drift: if a feature
// describes behavior the engine doesn't have, the test goes red.
//
// Supported subset: Feature, Scenario, and the step keywords Given/When/Then/
// And/But. Tag lines (@…), comments (#…) and free-text description lines are
// ignored. No Scenario Outline / tables / doc-strings (kept deliberately small).

export type Step = { keyword: string; text: string };
export type Scenario = { name: string; steps: Step[] };
export type Feature = { name: string; scenarios: Scenario[] };

const STEP_RE = /^(Given|When|Then|And|But)\s+(.*)$/;

/** Parse a .feature source into a Feature (name + scenarios + steps). */
export function parseFeature(src: string): Feature {
  const feature: Feature = { name: "", scenarios: [] };
  let current: Scenario | null = null;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("@")) continue;
    if (line.startsWith("Feature:")) {
      feature.name = line.slice("Feature:".length).trim();
      continue;
    }
    if (line.startsWith("Scenario:")) {
      current = { name: line.slice("Scenario:".length).trim(), steps: [] };
      feature.scenarios.push(current);
      continue;
    }
    const m = STEP_RE.exec(line);
    if (m && current) {
      current.steps.push({ keyword: m[1]!, text: m[2]! });
    }
    // anything else (feature/scenario description) is ignored
  }
  return feature;
}

/** A step's world: a mutable bag the steps of one scenario share. */
export type World = Record<string, unknown>;
export type StepFn = (world: World, ...args: string[]) => void | Promise<void>;

/** A registry of step definitions: regex → function. Step keyword (Given/When/
 *  Then/And) is intentionally ignored for matching — only the text matters, so
 *  "And …" reuses whatever defined the phrase. */
export class StepRegistry {
  private defs: { re: RegExp; fn: StepFn }[] = [];

  step(pattern: RegExp, fn: StepFn): this {
    this.defs.push({ re: pattern, fn });
    return this;
  }

  /** Run every step of a scenario in order against a fresh-or-given world. */
  async run(scenario: Scenario, world: World = {}): Promise<void> {
    for (const s of scenario.steps) {
      const def = this.defs.find((d) => d.re.test(s.text));
      if (!def) {
        throw new Error(`no step definition matches: ${s.keyword} ${s.text}`);
      }
      const m = s.text.match(def.re)!;
      await def.fn(world, ...m.slice(1));
    }
  }
}
