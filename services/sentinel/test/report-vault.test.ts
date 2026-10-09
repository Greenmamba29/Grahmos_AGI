import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderReport } from "../src/report.js";
import { PushedHostContext, Sentinel } from "../src/sentinel.js";
import type { Episode } from "../src/types.js";
import { exportVault } from "../src/vault.js";
import { drive, fixedModel, makeHarness, tempDir } from "./helpers.js";

const episode = (over: Partial<Episode> = {}): Episode => ({
  id: "m|4k#1@600",
  stream: "m|4k",
  model: "m",
  band: "4k",
  state: "closed",
  onsetAt: "2026-10-09T05:00:00.000Z",
  onsetSeq: 600,
  detectedAt: "2026-10-09T05:10:00.000Z",
  detectedSeq: 620,
  endAt: "2026-10-09T07:30:00.000Z",
  endSeq: 900,
  endDetectedAt: "2026-10-09T07:40:00.000Z",
  baselineRate: 0.03,
  episodeRate: 0.21,
  probes: 300,
  hallucinations: 63,
  hostAtOnset: { modelId: "m", quantization: "q4_k_m", checkpoint: "ckpt-1" },
  attribution: [{ factor: "thermalDerate", baseline: 0.03, inEpisode: 0.4, effect: 9.1 }],
  attach: { model: "m", checkpoint: "ckpt-1", quantization: "q4_k_m" },
  evidence: ["p1-601", "p1-605"],
  ...over,
});

describe("renderReport", () => {
  it("renders a self-contained report with a chart, episodes and streams", async () => {
    const h = makeHarness(tempDir());
    await drive(h, 450);
    const html = renderReport(h.sentinel, { title: "My report", note: "simulated" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<h1>My report</h1>");
    expect(html).toContain('<p class="meta">simulated</p>');
    expect(html).toContain("<polyline");
    expect(html).toContain('class="ep"');
    expect(html).toContain("450 probes");
    expect(html).toContain(h.sentinel.auditHead.slice(0, 16));
    expect(html).not.toMatch(/<script|src="http/); // no external resources
    for (const e of h.sentinel.episodes()) expect(html).toContain(`#${e.onsetSeq}`);
  });

  it("handles an empty sentinel", () => {
    const s = new Sentinel({ model: fixedModel("x"), host: new PushedHostContext({ modelId: "m" }), dataDir: tempDir(), bands: [400] });
    const html = renderReport(s);
    expect(html).toContain("No observations yet.");
    expect(html).toContain("None.");
    expect(html).toContain("Sentinel — hallucination episodes");
  });

  it("escapes stream, model and attribution text", async () => {
    const evil = `<img src=x onerror="alert(1)">&`;
    const s = new Sentinel({ model: fixedModel("999"), host: new PushedHostContext({ modelId: evil, quantization: `<q>` }), dataDir: tempDir(), bands: [400], monitor: { warmup: 5 } });
    for (let k = 0; k < 40; k++) await s.probeOnce();
    const html = renderReport(s, { title: "<b>t</b>", note: `"n"` });
    expect(html).not.toContain(evil);
    expect(html).not.toContain("<q>");
    expect(html).not.toContain("<b>t</b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
    expect(html).toContain("&lt;b&gt;t&lt;/b&gt;");
    expect(html).toContain("&quot;n&quot;");
  });
});

describe("exportVault", () => {
  it("writes one note per episode with YAML frontmatter and wiki links, plus model notes", () => {
    const dir = join(tempDir(), "vault");
    const eps = [
      episode(),
      episode({ id: "m|32k#1@1300", stream: "m|32k", band: "32k", onsetSeq: 1300, state: "open", endAt: undefined, endSeq: undefined, attribution: [], attach: { model: "m" } }),
      episode({ id: "other|1k#1@5", stream: "other|1k", model: "other/model:v2", onsetSeq: 5 }),
    ];
    const { files } = exportVault(eps, dir);
    expect(files).toBe(5);
    expect(readdirSync(join(dir, "Episodes")).sort()).toEqual(["EP m_32k 1300.md", "EP m_4k 600.md", "EP other_1k 5.md"]);
    expect(readdirSync(join(dir, "Models")).sort()).toEqual(["m.md", "other_model_v2.md"]);

    const note = readFileSync(join(dir, "Episodes", "EP m_4k 600.md"), "utf8");
    const [, fm, body] = note.split(/^---$/m) as [string, string, string];
    expect(note.startsWith("---\n")).toBe(true);
    expect(fm).toContain('stream: "m|4k"');
    expect(fm).toContain('model: "m"');
    expect(fm).toContain('state: "closed"');
    expect(fm).toContain('onset: "2026-10-09T05:00:00.000Z"');
    expect(fm).toContain('end: "2026-10-09T07:30:00.000Z"');
    expect(fm).toContain('band: "4k"');
    expect(fm).not.toContain("retrospective");
    expect(fm).not.toContain("split_from");
    expect(fm).toContain("baseline_rate: 0.03");
    expect(fm).toContain("episode_rate: 0.21");
    expect(fm).toContain('quantization: "q4_k_m"');
    expect(fm).toContain('checkpoint: "ckpt-1"');
    expect(fm).toContain("tags: [hallucination-episode]");
    expect(body).toContain("Model: [[Models/m]]");
    expect(body).toContain("# Hallucination episode on m\\|4k");
    expect(body).toContain("- Rate: 3.0% baseline → 21.0% (63/300 probes)");
    expect(body).toContain("- thermalDerate: 0.03 → 0.4 (effect 9.1)");
    expect(body).toContain("- p1-601");

    const open = readFileSync(join(dir, "Episodes", "EP m_32k 1300.md"), "utf8");
    expect(open).toContain("- Ended (estimated): ongoing");
    expect(open).not.toMatch(/^end:/m);
    expect(open).not.toMatch(/^quantization:/m);
    expect(open).toContain("- Nothing measurable changed in the host signals.");

    const model = readFileSync(join(dir, "Models", "m.md"), "utf8");
    expect(model).toContain("2 hallucination episode(s).");
    expect(model).toContain("[[Episodes/EP m_4k 600]]");
    expect(model).toContain("[[Episodes/EP m_32k 1300]]");
    // Wiki links resolve to files that exist.
    for (const m of [...model.matchAll(/\[\[([^\]]+)\]\]/g)]) expect(existsSync(join(dir, `${m[1]}.md`))).toBe(true);
    const other = readFileSync(join(dir, "Episodes", "EP other_1k 5.md"), "utf8");
    expect(other).toContain("Model: [[Models/other_model_v2]]");
  });

  it("marks retrospective split episodes in the frontmatter", () => {
    const dir = join(tempDir(), "vault");
    exportVault([episode({ id: "m|4k#2@700", onsetSeq: 700, retrospective: true, splitFrom: "m|4k#1@600" })], dir);
    const note = readFileSync(join(dir, "Episodes", "EP m_4k 700.md"), "utf8");
    expect(note).toMatch(/^retrospective: true$/m);
    expect(note).toMatch(/^split_from: "m\|4k#1@600"$/m);
  });

  it("cannot break out of the frontmatter or inject links/HTML from logged values", () => {
    const dir = join(tempDir(), "vault");
    const evil = 'q4"\n---\ninjected: true';
    exportVault(
      [
        episode({
          stream: "m|[[Secrets]]<b>",
          attach: { model: "m", quantization: evil, checkpoint: "c\nnext" },
          attribution: [{ factor: "extra.[[x]]", baseline: "<img>", inEpisode: "a|b", effect: 1 }],
          evidence: ["p1-1`\n# heading"],
        }),
      ],
      dir,
    );
    const [file] = readdirSync(join(dir, "Episodes"));
    const note = readFileSync(join(dir, "Episodes", file!), "utf8");
    // Exactly two frontmatter fences, and the injected key is inside a JSON string.
    expect(note.match(/^---$/gm)).toHaveLength(2);
    expect(note).not.toMatch(/^injected: true$/m);
    expect(note).toContain(`quantization: ${JSON.stringify(evil)}`);
    expect(note).toContain(`checkpoint: ${JSON.stringify("c\nnext")}`);
    const body = note.split(/^---$/m)[2]!;
    expect(body).not.toContain("[[Secrets]]");
    expect(body).not.toContain("<b>");
    expect(body).not.toContain("<img>");
    expect(body).not.toMatch(/^# heading/m);
    expect(body).toContain("\\[\\[Secrets\\]\\]");
    expect(body).toContain("- extra.\\[\\[x\\]\\]: \\<img\\> → a\\|b (effect 1)");
  });

  it("writes nothing but the folders for no episodes", () => {
    const dir = join(tempDir(), "v");
    expect(exportVault([], dir)).toEqual({ files: 0 });
    expect(readdirSync(dir).sort()).toEqual(["Episodes", "Models"]);
  });
});
