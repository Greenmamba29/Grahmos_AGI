import { ABSTAIN, type ValueType } from "./probes.js";
import type { Outcome, Probe } from "./types.js";

/**
 * Scores an answer against a probe.
 *
 *  correct       grounded: exactly one candidate value, and it is the reference
 *                unanswerable: abstains and names no concrete value
 *  abstained     grounded: says the document does not give it (a miss, not a hallucination)
 *  hallucinated  a wrong value; a value borrowed from another record; several
 *                different values ("450 or 460" is a guess, not an answer); or
 *                any concrete value for an unanswerable question, even
 *                alongside an abstention ("not stated, probably 450")
 *  invalid       nothing to score (empty, or only reasoning text)
 *
 * Values are compared by type, so formatting differences are not errors:
 *   int      "1,200" = "1200", "450kW" = "450", "450.0" = "450"
 *   version  exact dotted token: "2.10.3" ≠ "2.1.3", and a version is not a number
 *   time     "7:05" = "07:05"
 *   code     core value: "CH-42" = "channel 42" = "42"; "Zone A3" = "A3" ≠ "B3"
 *   text     case/punctuation-insensitive phrase match
 * Numbers and codes that appear in the question itself (entity names such as
 * "Brakel-42" or "node AX123") are never counted as answers.
 */

const ABSTAIN_RE = new RegExp(
  [
    ABSTAIN,
    "not (?:explicitly )?(?:stated|mentioned|specified|given|provided|listed|included|present|available|found|recorded)",
    "(?:does|do|did)(?: not|n't) (?:contain|include|list|mention|say|specify|state|provide|give|appear|show|record)",
    "no (?:information|data|record|mention|entry|value)",
    "unknown",
    "cannot (?:be )?determined?",
    "can(?:no|')t (?:be )?(?:determined?|found|answered)",
    "unable to (?:determine|find|answer)",
    "i (?:don't|do not) know",
    "not in (?:the )?documents?",
  ].join("|"),
  "i",
);

/** Removes reasoning blocks some models emit before the answer. */
export function stripReasoning(text: string): string {
  let t = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  // An unclosed block means the answer never came (cut off while thinking).
  t = t.replace(/<think(?:ing)?>[\s\S]*$/i, "");
  return t.trim();
}

const normText = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s*_`"'.,;:!?()[\]{}-]+/g, " ")
    .trim();

/** Typed value tokens in a text, normalized for comparison. */
export function valueTokens(text: string, type: ValueType): string[] {
  const t = text.toLowerCase();
  const out: string[] = [];
  switch (type) {
    case "int": {
      // Drop versions and times first so their parts are not read as numbers.
      const rest = t.replace(/\d+(?:\.\d+){2,}/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ");
      for (const m of rest.matchAll(/\d{1,3}(?:,\d{3})+(?![\d,])|\d+(?:\.\d+)?/g)) {
        const raw = m[0].replace(/,/g, "");
        const v = Number(raw);
        if (Number.isFinite(v)) out.push(String(v));
      }
      break;
    }
    case "version":
      for (const m of t.matchAll(/(?<![\d.])v?(\d+(?:\.\d+){2,})(?![\d]|\.\d)/g)) out.push(m[1]!.split(".").map((p) => String(Number(p))).join("."));
      break;
    case "time":
      for (const m of t.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) out.push(`${m[1]!.padStart(2, "0")}:${m[2]}`);
      break;
    case "code":
      // A single letter glued to digits is part of the code ("a3", "f123");
      // a longer prefix is a label ("ch42", "sev2", "ax123") and is dropped.
      for (const m of t.matchAll(/([a-z]*)(\d+)(?!\d)/g)) out.push(`${m[1]!.length === 1 ? m[1] : ""}${String(Number(m[2]))}`);
      break;
    case "text":
      break;
  }
  return out;
}

/** Core of a code value: "CH-42" → "42", "SEV-2" → "2", "Zone A3" → "a3", "F123" → "f123". */
export function codeCore(value: string): string {
  const toks = valueTokens(value, "code");
  return toks.at(-1) ?? normText(value);
}

function sameCode(token: string, core: string): boolean {
  if (token === core) return true;
  const [tl, td] = [token.replace(/\d+$/, ""), token.replace(/^[a-z]/, "")];
  const [cl, cd] = [core.replace(/\d+$/, ""), core.replace(/^[a-z]/, "")];
  return td === cd && (!tl || !cl || tl === cl);
}

function normValue(value: string, type: ValueType): string {
  if (type === "code") return codeCore(value);
  if (type === "text") return normText(value);
  return valueTokens(value, type)[0] ?? normText(value);
}

function textContains(answer: string, value: string): boolean {
  const a = ` ${normText(answer)} `;
  const v = normText(value);
  return v.length > 0 && a.includes(` ${v} `);
}

/**
 * Distinct candidate values in an answer for the probe's attribute, after
 * removing anything that also appears in the question. For text attributes,
 * candidates are the known values (reference and distractors) found in it.
 */
export function candidates(probe: Pick<Probe, "valueType" | "question" | "reference" | "distractors">, answer: string): string[] {
  const type = probe.valueType;
  if (type === "text") {
    const known = [probe.reference, ...probe.distractors].filter((v) => v !== ABSTAIN);
    const hits = known.filter((v) => textContains(answer, v));
    // Drop values that are only part of a longer matched value ("Kel" inside "Kel Mar").
    return [...new Set(hits.filter((h) => !hits.some((o) => o !== h && textContains(o, h))).map(normText))];
  }
  const inQuestion = new Set(valueTokens(probe.question, type));
  // A question value is ignored unless it is the reference itself
  // ("docks of facility Salfenvin-29" with reference 29).
  return [...new Set(valueTokens(answer, type).filter((t) => !inQuestion.has(t) || (probe.reference !== ABSTAIN && matches(probe, t, probe.reference))))];
}

function matches(probe: Pick<Probe, "valueType">, token: string, value: string): boolean {
  const v = normValue(value, probe.valueType);
  return probe.valueType === "code" ? sameCode(token, v) : token === v;
}

export function scoreAnswer(probe: Probe, rawAnswer: string): { outcome: Outcome; confusedWith?: string } {
  const text = stripReasoning(rawAnswer);
  if (!text) return { outcome: "invalid" };
  const cands = candidates(probe, text);
  const abstains = ABSTAIN_RE.test(text);
  const confusion = () => {
    const d = probe.distractors.find((v) => cands.some((c) => matches(probe, c, v)));
    return d ? { confusedWith: d } : {};
  };

  if (probe.kind === "unanswerable") {
    if (cands.length > 0) return { outcome: "hallucinated", ...confusion() };
    return abstains ? { outcome: "correct" } : { outcome: "hallucinated" };
  }
  if (cands.length === 1 && matches(probe, cands[0]!, probe.reference)) return { outcome: "correct" };
  if (cands.length === 0) return abstains ? { outcome: "abstained" } : { outcome: "hallucinated" };
  return { outcome: "hallucinated", ...confusion() };
}

/**
 * Grounding check for live traffic: every number and every quoted string in
 * the answer must appear in at least one source. Returns the unsupported
 * spans. Coarse by design — it catches invented figures and quotes, which
 * are the hallucinations that matter most in operations work, and nothing
 * subtler.
 */
export function checkGrounding(answer: string, sources: string[]): { supported: boolean; unsupported: string[]; checked: number } {
  const corpus = sources.join("\n").toLowerCase();
  const corpusNums = new Set((corpus.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, "")));
  const spans: string[] = [];
  for (const m of stripReasoning(answer).matchAll(/\d+(?:[.,]\d+)*/g)) spans.push(m[0]);
  for (const m of stripReasoning(answer).matchAll(/"([^"]{4,200})"|“([^”]{4,200})”/g)) spans.push((m[1] ?? m[2])!);
  const unsupported = spans.filter((s) => (/^\d/.test(s) ? !corpusNums.has(s.replace(/,/g, "")) : !corpus.includes(s.toLowerCase())));
  return { supported: unsupported.length === 0, unsupported: [...new Set(unsupported)], checked: spans.length };
}
