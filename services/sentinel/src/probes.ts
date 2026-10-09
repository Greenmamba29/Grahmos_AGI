import { mulberry32 } from "@grahmos/gate";
import type { Probe, ProbeKind } from "./types.js";

/**
 * Probe generator. Every probe is a short document about fictional GrahmOS
 * operations (facilities, mesh nodes, incidents, rosters) plus one question.
 *
 *  grounded      — the answer is in the document; a different value is a hallucination
 *  unanswerable  — the document does not contain the answer; any specific answer is a hallucination
 *
 * Entities and values are invented, so the model cannot answer from world
 * knowledge: the only way to be right is to read the document. Distractor
 * documents about other entities pad the prompt to a target length, so the
 * same probe family measures hallucination at 1k, 4k, 16k, 32k… tokens and
 * shows where it begins.
 */

export const ABSTAIN = "NOT IN DOCUMENT";

const INSTRUCTION = `Answer using only the documents provided. Reply with the value only, no explanation. If the documents do not contain the answer, reply exactly: ${ABSTAIN}`;

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const SYLLABLES = ["bra", "kel", "tor", "vin", "osh", "mar", "dun", "lex", "qui", "rho", "zan", "pel", "gor", "fen", "sal", "tir"] as const;
function name(r: Rand): string {
  const s = pick(r, SYLLABLES) + pick(r, SYLLABLES) + (r() < 0.5 ? pick(r, SYLLABLES) : "");
  return s[0]!.toUpperCase() + s.slice(1);
}

/** How answers for an attribute are compared (see score.ts). */
export type ValueType = "int" | "version" | "time" | "code" | "text";

interface Attr {
  key: string;
  label: string;
  type: ValueType;
  value: (r: Rand) => string;
}

interface Template {
  id: string;
  entity: (r: Rand) => string;
  heading: (e: string) => string;
  question: (e: string, a: Attr) => string;
  attrs: readonly Attr[];
}

const TEMPLATES: readonly Template[] = [
  {
    id: "facility-spec",
    entity: (r) => `${name(r)}-${int(r, 2, 99)}`,
    heading: (e) => `Facility record: ${e}`,
    question: (e, a) => `What is the ${a.label} of facility ${e}?`,
    attrs: [
      { key: "gen_kw", label: "backup generator rating in kW", type: "int", value: (r) => String(int(r, 12, 98) * 10) },
      { key: "shifts", label: "number of daily shifts", type: "int", value: (r) => String(int(r, 1, 4)) },
      { key: "staff", label: "headcount", type: "int", value: (r) => String(int(r, 14, 940)) },
      { key: "year", label: "commissioning year", type: "int", value: (r) => String(int(r, 1968, 2025)) },
      { key: "fuel_h", label: "on-site fuel autonomy in hours", type: "int", value: (r) => String(int(r, 6, 120)) },
      { key: "nodes", label: "number of mesh relay nodes", type: "int", value: (r) => String(int(r, 3, 64)) },
      { key: "dock", label: "number of loading docks", type: "int", value: (r) => String(int(r, 1, 30)) },
      { key: "radio", label: "primary radio channel", type: "code", value: (r) => `CH-${int(r, 10, 99)}` },
    ],
  },
  {
    id: "mesh-node",
    entity: (r) => `node ${pick(r, ["AX", "BQ", "CR", "DM", "EV"])}${int(r, 100, 999)}`,
    heading: (e) => `Mesh inventory entry: ${e}`,
    question: (e, a) => `What is the ${a.label} of ${e}?`,
    attrs: [
      { key: "fw", label: "firmware version", type: "version", value: (r) => `${int(r, 1, 9)}.${int(r, 0, 19)}.${int(r, 0, 9)}` },
      { key: "batt", label: "battery level in percent", type: "int", value: (r) => String(int(r, 5, 100)) },
      { key: "hops", label: "hop count to the gateway", type: "int", value: (r) => String(int(r, 1, 12)) },
      { key: "freq", label: "radio frequency in MHz", type: "int", value: (r) => String(pick(r, [433, 868, 902, 915, 2400])) },
      { key: "site", label: "installation site", type: "text", value: (r) => `${name(r)} ${pick(r, ["Depot", "Clinic", "Substation", "Shelter", "Plant"])}` },
      { key: "peers", label: "number of direct peers", type: "int", value: (r) => String(int(r, 1, 16)) },
      { key: "solar", label: "solar panel wattage", type: "int", value: (r) => String(int(r, 2, 40) * 5) },
    ],
  },
  {
    id: "incident-log",
    entity: (r) => `incident INC-${int(r, 10000, 99999)}`,
    heading: (e) => `Incident report: ${e}`,
    question: (e, a) => `For ${e}, what was the ${a.label}?`,
    attrs: [
      { key: "sev", label: "severity level", type: "code", value: (r) => `SEV-${int(r, 1, 4)}` },
      { key: "dur", label: "outage duration in minutes", type: "int", value: (r) => String(int(r, 3, 480)) },
      { key: "aff", label: "number of affected nodes", type: "int", value: (r) => String(int(r, 1, 120)) },
      { key: "code", label: "fault code", type: "code", value: (r) => `F${int(r, 100, 999)}` },
      { key: "lead", label: "responding engineer", type: "text", value: (r) => `${name(r)} ${name(r)}` },
      { key: "start", label: "start time (24h)", type: "time", value: (r) => `${String(int(r, 0, 23)).padStart(2, "0")}:${String(int(r, 0, 59)).padStart(2, "0")}` },
      { key: "rollback", label: "firmware version rolled back to", type: "version", value: (r) => `${int(r, 1, 9)}.${int(r, 0, 19)}.${int(r, 0, 9)}` },
    ],
  },
  {
    id: "shift-roster",
    entity: (r) => `operator ${name(r)} ${name(r)}`,
    heading: (e) => `Roster entry: ${e}`,
    question: (e, a) => `What is the ${a.label} for ${e}?`,
    attrs: [
      { key: "badge", label: "badge number", type: "int", value: (r) => String(int(r, 10000, 99999)) },
      { key: "role", label: "certified role", type: "text", value: (r) => pick(r, ["line lead", "radio operator", "QA inspector", "forklift operator", "EMT liaison", "electrician"]) },
      { key: "hours", label: "weekly contracted hours", type: "int", value: (r) => String(int(r, 16, 48)) },
      { key: "zone", label: "assigned zone", type: "code", value: (r) => `Zone ${pick(r, ["A", "B", "C", "D", "E", "F"])}${int(r, 1, 9)}` },
      { key: "cert", label: "safety certification expiry year", type: "int", value: (r) => String(int(r, 2026, 2031)) },
      { key: "ext", label: "radio extension", type: "int", value: (r) => String(int(r, 200, 899)) },
    ],
  },
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

interface Doc {
  entity: string;
  text: string;
  values: Map<string, string>;
}

function makeDoc(t: Template, r: Rand, omit?: string): Doc {
  const entity = t.entity(r);
  const values = new Map<string, string>();
  const lines = [t.heading(entity)];
  for (const a of t.attrs) {
    if (a.key === omit) continue;
    const v = a.value(r);
    values.set(a.key, v);
    lines.push(`- ${a.label[0]!.toUpperCase()}${a.label.slice(1)}: ${v}`);
  }
  return { entity, text: lines.join("\n"), values };
}

export interface GenerateOptions {
  /** Target prompt sizes in tokens; probes cycle through them. */
  bands: number[];
}

export const DEFAULT_BANDS = [1000, 4000, 16000, 32000];

/**
 * Prompt-size estimate in tokens. Deliberately conservative (3 chars/token;
 * real tokenizers give ~3.5–4 on this text) so a probe never exceeds its band
 * on the model that serves it.
 */
export const CHARS_PER_TOKEN = 3;

/**
 * Family name: template × kind × asked attribute. Families are the unit of
 * pool assignment, so a training family and a monitoring family differ in
 * what they ask, not only in a label: training on "generator rating"
 * questions cannot teach the answers to the monitor's "badge number" ones.
 */
export const familyOf = (template: string, kind: ProbeKind, attrKey: string) => `${template}/${kind}/${attrKey}`;

/**
 * Deterministic probe for sequence number `seq`. The same (seed, seq) always
 * yields the same probe, so a run can be replayed and audited.
 */
export function generateProbe(seed: number, seq: number, opts: GenerateOptions): Probe {
  const r = mulberry32((seed * 2654435761 + seq * 40503) >>> 0);
  const t = TEMPLATES[seq % TEMPLATES.length]!;
  const kind: ProbeKind = Math.floor(seq / TEMPLATES.length) % 3 === 2 ? "unanswerable" : "grounded";
  const band = opts.bands[Math.floor(seq / (TEMPLATES.length * 3)) % opts.bands.length]!;
  const attr = pick(r, t.attrs);

  const target = makeDoc(t, r, kind === "unanswerable" ? attr.key : undefined);
  const targetValue = target.values.get(attr.key);
  const docs: Doc[] = [target];
  // Pad with distractor records of the same kind until the prompt reaches the
  // band. A distractor never shares the target's value for the asked
  // attribute, so "borrowed a value from another record" is always wrong.
  let chars = target.text.length + INSTRUCTION.length + 200;
  for (let tries = 0; chars < band * CHARS_PER_TOKEN; tries++) {
    const d = makeDoc(t, r);
    if (d.entity === target.entity || (targetValue !== undefined && d.values.get(attr.key) === targetValue)) {
      if (tries > 100_000) throw new Error(`cannot build distractors for ${t.id}/${attr.key}`);
      continue;
    }
    docs.push(d);
    chars += d.text.length + 2;
  }
  // Place the target at a random depth.
  const at = int(r, 0, docs.length - 1);
  [docs[0], docs[at]] = [docs[at]!, docs[0]!];

  const body = docs.map((d) => d.text).join("\n\n");
  const question = t.question(target.entity, attr);
  const distractors = [...new Set(docs.filter((d) => d !== target).map((d) => d.values.get(attr.key)).filter((v): v is string => !!v))].slice(0, 50);
  return {
    id: `p${seed}-${seq}`,
    seq,
    family: familyOf(t.id, kind, attr.key),
    template: t.id,
    kind,
    attrKey: attr.key,
    valueType: attr.type,
    question,
    band,
    contextTokens: Math.ceil((body.length + question.length + INSTRUCTION.length) / CHARS_PER_TOKEN),
    messages: [
      { role: "system", content: INSTRUCTION },
      { role: "user", content: `${body}\n\nQuestion: ${question}` },
    ],
    reference: kind === "unanswerable" ? ABSTAIN : target.values.get(attr.key)!,
    distractors,
  };
}

/** All families the generator can produce (for pool planning). */
export function allFamilies(): string[] {
  const out: string[] = [];
  for (const t of TEMPLATES) for (const k of ["grounded", "unanswerable"] as const) for (const a of t.attrs) out.push(familyOf(t.id, k, a.key));
  return out;
}
