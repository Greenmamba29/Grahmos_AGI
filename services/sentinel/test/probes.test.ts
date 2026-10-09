import { describe, expect, it } from "vitest";
import { ABSTAIN, allFamilies, CHARS_PER_TOKEN, DEFAULT_BANDS, familyOf, generateProbe, TEMPLATE_IDS } from "../src/probes.js";
import type { Probe } from "../src/types.js";

/** Splits the user message into document blocks and returns the target block (the one the question is about). */
function targetBlock(p: Probe): { block: string; others: string[] } {
  const user = p.messages[1]!.content!;
  const [body, question] = user.split("\n\nQuestion: ") as [string, string];
  const blocks = body.split("\n\n");
  const entityOf = (b: string) => b.split("\n")[0]!.split(": ").slice(1).join(": ");
  const hits = blocks.filter((b) => question.includes(` ${entityOf(b)}?`) || question.includes(` ${entityOf(b)},`));
  expect(hits).toHaveLength(1);
  return { block: hits[0]!, others: blocks.filter((b) => b !== hits[0]) };
}

describe("generateProbe", () => {
  const opts = { bands: [1000, 4000] };

  it("is deterministic in (seed, seq)", () => {
    expect(generateProbe(7, 3, opts)).toEqual(generateProbe(7, 3, opts));
    expect(generateProbe(7, 3, opts)).not.toEqual(generateProbe(7, 4, opts));
    expect(generateProbe(7, 3, opts)).not.toEqual(generateProbe(8, 3, opts));
    expect(generateProbe(7, 3, opts).id).toBe("p7-3");
  });

  it("cycles templates, kinds and bands on a fixed schedule", () => {
    const n = TEMPLATE_IDS.length;
    for (let seq = 0; seq < 6 * n; seq++) {
      const p = generateProbe(1, seq, opts);
      expect(p.template).toBe(TEMPLATE_IDS[seq % n]);
      expect(p.kind).toBe(Math.floor(seq / n) % 3 === 2 ? "unanswerable" : "grounded");
      expect(p.band).toBe(opts.bands[Math.floor(seq / (n * 3)) % 2]);
    }
  });

  it("reaches the band size by the chars/3 estimate (≥ 0.8 × band, not wildly over)", () => {
    expect(CHARS_PER_TOKEN).toBe(3);
    for (const band of [1000, 4000, 16000]) {
      for (let k = 0; k < 4; k++) {
        const p = generateProbe(3, k, { bands: [band] });
        expect(p.band).toBe(band);
        expect(p.contextTokens).toBeGreaterThanOrEqual(0.8 * band);
        expect(p.contextTokens).toBeLessThanOrEqual(1.1 * band);
        const chars = p.messages.reduce((s, m) => s + (m.content ?? "").length, 0);
        expect(Math.abs(Math.ceil(chars / 3) - p.contextTokens)).toBeLessThan(10);
      }
    }
  });

  it("carries seq, attrKey, valueType and the question", () => {
    const types = new Set<string>();
    for (let seq = 0; seq < 120; seq++) {
      const p = generateProbe(4, seq, { bands: [500] });
      expect(p.seq).toBe(seq);
      expect(p.family).toBe(familyOf(p.template, p.kind, p.attrKey));
      expect(p.messages[1]!.content!.endsWith(`Question: ${p.question}`)).toBe(true);
      expect(["int", "version", "time", "code", "text"]).toContain(p.valueType);
      types.add(p.valueType);
    }
    expect([...types].sort()).toEqual(["code", "int", "text", "time", "version"]);
  });

  it("distractors never share the target's value for the asked attribute", () => {
    let checked = 0;
    let lines = 0;
    // Small-range attributes (shifts 1–4, certification year, role, frequency) are where collisions would happen.
    for (const seed of [1, 2, 3]) {
      for (let seq = 0; seq < 96; seq++) {
        const p = generateProbe(seed, seq, { bands: [2000] });
        if (p.kind !== "grounded") continue;
        checked++;
        expect(p.distractors).not.toContain(p.reference);
        const { block, others } = targetBlock(p);
        // The asked attribute's line in the target is the one whose value is the reference
        // and whose label appears in the question (longest such label).
        const label = (l: string) => l.replace(/^- /, "").split(": ")[0]!;
        const asked = block
          .split("\n")
          .slice(1)
          .filter((l) => l.endsWith(`: ${p.reference}`) && p.question.toLowerCase().includes(label(l).toLowerCase()))
          .map(label)
          .sort((x, y) => y.length - x.length)[0]!;
        expect(asked).toBeDefined();
        for (const o of others) {
          const line = o.split("\n").find((l) => label(l) === asked);
          if (!line) continue;
          lines++;
          expect(line.endsWith(`: ${p.reference}`)).toBe(false);
        }
      }
    }
    expect(checked).toBeGreaterThan(150);
    expect(lines).toBeGreaterThan(1000);
  });

  it("has a system instruction and a user document + question", () => {
    const p = generateProbe(1, 0, opts);
    expect(p.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(p.messages[0]!.content).toContain(ABSTAIN);
    expect(p.messages[1]!.content).toMatch(/\n\nQuestion: .+\?$/);
  });

  it("grounded probes have the reference in the target record", () => {
    let seen = 0;
    for (let seq = 0; seq < 48; seq++) {
      const p = generateProbe(5, seq, opts);
      if (p.kind !== "grounded") continue;
      seen++;
      const { block } = targetBlock(p);
      expect(block.split("\n").some((l) => l.endsWith(`: ${p.reference}`))).toBe(true);
      expect(p.reference).not.toBe(ABSTAIN);
    }
    expect(seen).toBe(32);
  });

  it("unanswerable probes omit exactly the asked attribute from the target record", () => {
    let seen = 0;
    for (let seq = 0; seq < 48; seq++) {
      const p = generateProbe(5, seq, opts);
      if (p.kind !== "unanswerable") continue;
      seen++;
      expect(p.reference).toBe(ABSTAIN);
      const { block, others } = targetBlock(p);
      const sameTemplate = others.filter((b) => b.split("\n")[0]!.split(": ")[0] === block.split("\n")[0]!.split(": ")[0]);
      expect(sameTemplate.length).toBeGreaterThan(0);
      const full = sameTemplate[0]!.split("\n").length;
      expect(block.split("\n").length).toBe(full - 1);
      // The asked label appears in the other records, not in the target.
      const question = p.messages[1]!.content!.split("Question: ")[1]!;
      const labels = sameTemplate[0]!.split("\n").slice(1).map((l) => l.replace(/^- /, "").split(": ")[0]!.toLowerCase());
      const asked = labels.filter((l) => question.toLowerCase().includes(l));
      expect(asked.length).toBeGreaterThan(0);
      const targetLabels = block.split("\n").slice(1).map((l) => l.replace(/^- /, "").split(": ")[0]!.toLowerCase());
      // The longest matching label is the asked one (labels can be prefixes of each other).
      const askedLabel = asked.sort((a, b) => b.length - a.length)[0]!;
      expect(targetLabels).not.toContain(askedLabel);
    }
    expect(seen).toBe(16);
  });

  it("distractors come from other records and are capped", () => {
    const p = generateProbe(9, 0, { bands: [16000] });
    expect(p.distractors.length).toBeGreaterThan(0);
    expect(p.distractors.length).toBeLessThanOrEqual(50);
    expect(new Set(p.distractors).size).toBe(p.distractors.length);
    for (const d of p.distractors) expect(p.messages[1]!.content).toContain(d);
  });

  it("uses familyOf naming (template/kind/attrKey) and stays within allFamilies", () => {
    const fams = new Set(allFamilies());
    for (let seq = 0; seq < 100; seq++) {
      const p = generateProbe(2, seq, { bands: [500] });
      expect(p.family).toMatch(/^[a-z-]+\/(grounded|unanswerable)\/[a-z_]+$/);
      expect(p.family).toBe(`${p.template}/${p.kind}/${p.attrKey}`);
      expect(fams.has(p.family)).toBe(true);
    }
    expect(familyOf("mesh-node", "grounded", "fw")).toBe("mesh-node/grounded/fw");
  });

  it("allFamilies counts templates × 2 kinds × attributes", () => {
    expect(TEMPLATE_IDS).toEqual(["facility-spec", "mesh-node", "incident-log", "shift-roster"]);
    const fams = allFamilies();
    expect(fams).toHaveLength(2 * (8 + 7 + 7 + 6));
    expect(new Set(fams).size).toBe(fams.length);
    expect(fams.filter((f) => f.includes("/unanswerable/"))).toHaveLength(28);
    expect(fams).toContain("shift-roster/grounded/zone");
    expect(DEFAULT_BANDS).toEqual([1000, 4000, 16000, 32000]);
  });
});
