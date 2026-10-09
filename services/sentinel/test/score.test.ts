import { describe, expect, it } from "vitest";
import { ABSTAIN, generateProbe, type ValueType } from "../src/probes.js";
import { candidates, checkGrounding, codeCore, scoreAnswer, stripReasoning, valueTokens } from "../src/score.js";
import type { Probe, ProbeKind } from "../src/types.js";

const base = generateProbe(1, 0, { bands: [500] });
const FACILITY_Q = "What is the backup generator rating in kW of facility Brakel-42?";

/** A probe with exactly the fields the scorer reads. */
const P = (valueType: ValueType, reference: string, distractors: string[], kind: ProbeKind = "grounded", question = FACILITY_Q): Probe => ({
  ...base,
  valueType,
  reference: kind === "unanswerable" ? ABSTAIN : reference,
  distractors,
  kind,
  question,
});

describe("scoreAnswer — coordinator checks", () => {
  // Ported from the reference check script.
  const cases: [Probe, string, string][] = [
    [P("int", "1200", ["1300"]), "1,200", "correct"],
    [P("int", "450", ["460"]), "450kW", "correct"],
    [P("int", "450", ["460"]), "Brakel-42 has 450 kW", "correct"],
    [P("int", "450", ["460"]), "450 or 460", "hallucinated"],
    [P("int", "450", ["460"]), "460", "hallucinated"],
    [P("int", "450", ["460"]), "The document does not state the rating.", "abstained"],
    [P("int", ABSTAIN, ["460"], "unanswerable"), ABSTAIN, "correct"],
    [P("int", ABSTAIN, ["460"], "unanswerable"), "Not stated, probably 460", "hallucinated"],
    [P("version", "2.10.3", ["2.1.3"]), "v2.10.3", "correct"],
    [P("version", "2.10.3", ["2.1.3"]), "2.1.3", "hallucinated"],
    [P("time", "07:05", ["08:05"]), "7:05", "correct"],
    [P("code", "CH-42", ["CH-43"], "grounded", "What is the primary radio channel of facility Brakel-17?"), "channel 42", "correct"],
    [P("code", "CH-42", ["CH-43"], "grounded", "What is the primary radio channel of facility Brakel-17?"), "ch42", "correct"],
    [P("code", "Zone A3", ["Zone B3"], "grounded", "What is the assigned zone for operator X Y?"), "A3", "correct"],
    [P("code", "Zone A3", ["Zone B3"], "grounded", "What is the assigned zone for operator X Y?"), "Zone B3", "hallucinated"],
    [P("code", "SEV-2", ["SEV-3"], "grounded", "For incident INC-12345, what was the severity level?"), "SEV-2", "correct"],
    [P("code", "F123", ["F124"], "grounded", "For incident INC-12345, what was the fault code?"), "F123", "correct"],
    [P("text", "line lead", ["electrician"]), "Line Lead.", "correct"],
    [P("text", "line lead", ["electrician"]), "<think>hmm electrician?</think>line lead", "correct"],
    [P("text", "line lead", ["electrician"]), "<think>hmm", "invalid"],
  ];
  it.each(cases.map(([p, a, want]) => [p.valueType, a, want, p] as const))("%s %j → %s", (_t, answer, want, p) => {
    expect(scoreAnswer(p, answer).outcome).toBe(want);
  });
});

describe("scoreAnswer — int", () => {
  const g = P("int", "45", ["72", "130"]);
  it.each([
    ["45", "correct"],
    [" 45 ", "correct"],
    ["The answer is 45.", "correct"],
    ["**45**", "correct"],
    ["45 kW", "correct"],
    ["45.0", "correct"],
    ["45 (other values are not stated)", "correct"],
    [ABSTAIN, "abstained"],
    ["not in the document", "abstained"],
    ["The value is not stated.", "abstained"],
    ["The documents do not contain this.", "abstained"],
    ["I don't know", "abstained"],
    ["Unknown", "abstained"],
    ["It cannot be determined", "abstained"],
    ["Unable to determine.", "abstained"],
    ["", "invalid"],
    ["   ", "invalid"],
    ["<think>45?</think>", "invalid"],
    ["Hmm.", "hallucinated"],
    ["99", "hallucinated"],
    ["450", "hallucinated"],
    ["145", "hallucinated"],
    ["4500", "hallucinated"],
    ["45.5", "hallucinated"],
    ["1.45", "hallucinated"],
    ["45 or 46", "hallucinated"],
  ] as const)("ref 45: %j → %s", (answer, outcome) => {
    expect(scoreAnswer(g, answer).outcome).toBe(outcome);
  });

  it("thousands separators are values, not two numbers", () => {
    expect(scoreAnswer(P("int", "450", []), "1,450").outcome).toBe("hallucinated");
    expect(scoreAnswer(P("int", "1450", []), "1,450").outcome).toBe("correct");
    expect(scoreAnswer(P("int", "24010", []), "Badge 24,010").outcome).toBe("correct");
  });

  it("reports the distractor a confused answer came from", () => {
    expect(scoreAnswer(g, "72")).toEqual({ outcome: "hallucinated", confusedWith: "72" });
    expect(scoreAnswer(g, "It is 130 units")).toEqual({ outcome: "hallucinated", confusedWith: "130" });
    expect(scoreAnswer(g, "45 or 72")).toEqual({ outcome: "hallucinated", confusedWith: "72" });
    expect(scoreAnswer(g, "99")).toEqual({ outcome: "hallucinated" });
    expect(scoreAnswer(g, "720")).toEqual({ outcome: "hallucinated" });
  });

  it("ignores numbers that appear in the question (entity names)", () => {
    const q = P("int", "450", ["460"], "grounded", "What is the backup generator rating in kW of facility Brakel-42?");
    expect(scoreAnswer(q, "Brakel-42: 450").outcome).toBe("correct");
    expect(scoreAnswer(q, "42").outcome).toBe("hallucinated"); // 42 is dropped: no value left, no abstention
    expect(scoreAnswer(q, "Facility Brakel-42 does not state it").outcome).toBe("abstained");
  });

  it("does not read versions or times as numbers", () => {
    expect(scoreAnswer(P("int", "3", []), "firmware 3.12.4").outcome).toBe("hallucinated");
    expect(scoreAnswer(P("int", "7", []), "at 07:05").outcome).toBe("hallucinated");
  });
});

describe("scoreAnswer — version / time / code / text", () => {
  it("versions match exactly", () => {
    const v = P("version", "3.12.4", ["3.1.4"]);
    expect(scoreAnswer(v, "3.12.4").outcome).toBe("correct");
    expect(scoreAnswer(v, "Firmware 3.12.4.").outcome).toBe("correct");
    expect(scoreAnswer(v, "v3.12.4").outcome).toBe("correct");
    expect(scoreAnswer(v, "3.12").outcome).toBe("hallucinated");
    expect(scoreAnswer(v, "13.12.4").outcome).toBe("hallucinated");
    expect(scoreAnswer(v, "3.12.4.1").outcome).toBe("hallucinated");
    expect(scoreAnswer(v, "3.1.4")).toEqual({ outcome: "hallucinated", confusedWith: "3.1.4" });
  });

  it("times compare zero-padded", () => {
    const t = P("time", "07:05", []);
    expect(scoreAnswer(t, "07:05").outcome).toBe("correct");
    expect(scoreAnswer(t, "7:05").outcome).toBe("correct");
    expect(scoreAnswer(t, "07:50").outcome).toBe("hallucinated");
    expect(scoreAnswer(t, "17:05").outcome).toBe("hallucinated");
  });

  it("codes compare by core value", () => {
    const ch = P("code", "CH-42", ["CH-43"], "grounded", "What is the primary radio channel of facility Brakel-17?");
    for (const a of ["CH-42", "channel 42", "ch42", "42", "Ch 42"]) expect(scoreAnswer(ch, a).outcome).toBe("correct");
    expect(scoreAnswer(ch, "CH-4").outcome).toBe("hallucinated");
    expect(scoreAnswer(ch, "CH-43")).toEqual({ outcome: "hallucinated", confusedWith: "CH-43" });
    // "17" comes from the question (Brakel-17) and is ignored.
    expect(scoreAnswer(ch, "Brakel-17 uses CH-42").outcome).toBe("correct");
    const zone = P("code", "Zone A3", ["Zone B3"], "grounded", "What is the assigned zone for operator X Y?");
    expect(scoreAnswer(zone, "Zone A3").outcome).toBe("correct");
    expect(scoreAnswer(zone, "a3").outcome).toBe("correct");
    expect(scoreAnswer(zone, "B3").outcome).toBe("hallucinated");
    expect(scoreAnswer(zone, "A4").outcome).toBe("hallucinated");
  });

  it("text values match as phrases, case- and punctuation-insensitively", () => {
    const t = P("text", "line lead", ["electrician", "radio operator"]);
    expect(scoreAnswer(t, "LINE LEAD").outcome).toBe("correct");
    expect(scoreAnswer(t, "The certified role is: line-lead.").outcome).toBe("correct");
    expect(scoreAnswer(t, "electrician")).toEqual({ outcome: "hallucinated", confusedWith: "electrician" });
    expect(scoreAnswer(t, "line lead or electrician").outcome).toBe("hallucinated");
    expect(scoreAnswer(t, "forklift operator").outcome).toBe("hallucinated"); // unknown value, no abstention
    expect(scoreAnswer(t, "Not stated.").outcome).toBe("abstained");
  });

  it("a longer known text value is not double counted with a shorter one inside it", () => {
    const t = P("text", "Kel Mar", ["Kel"]);
    expect(candidates(t, "Kel Mar")).toEqual(["kel mar"]);
    expect(scoreAnswer(t, "Kel Mar").outcome).toBe("correct");
  });
});

describe("scoreAnswer — unanswerable", () => {
  const u = P("int", ABSTAIN, ["72", "130"], "unanswerable");
  it("abstaining with no value is correct", () => {
    for (const a of [ABSTAIN, "The documents do not mention it.", "No information available", "unknown"]) expect(scoreAnswer(u, a)).toEqual({ outcome: "correct" });
  });
  it("any concrete value is a hallucination, even alongside an abstention", () => {
    expect(scoreAnswer(u, "72")).toEqual({ outcome: "hallucinated", confusedWith: "72" });
    expect(scoreAnswer(u, "500")).toEqual({ outcome: "hallucinated" });
    expect(scoreAnswer(u, "Not stated, but probably 130")).toEqual({ outcome: "hallucinated", confusedWith: "130" });
    expect(scoreAnswer(u, "Hmm, hard to say.")).toEqual({ outcome: "hallucinated" });
  });
  it("empty answers are invalid, not correct", () => {
    expect(scoreAnswer(u, "")).toEqual({ outcome: "invalid" });
  });
});

describe("helpers", () => {
  it("stripReasoning removes closed blocks and drops everything after an unclosed one", () => {
    expect(stripReasoning("<think>a\nb</think> 42 ")).toBe("42");
    expect(stripReasoning("<thinking>x</thinking>A<THINK>y</THINK>B")).toBe("AB");
    expect(stripReasoning("answer <think>still going")).toBe("answer");
    expect(stripReasoning("<think>never closed")).toBe("");
    expect(stripReasoning("plain")).toBe("plain");
  });

  it("valueTokens normalizes by type", () => {
    expect(valueTokens("1,200 and 450kW and 45.50", "int")).toEqual(["1200", "450", "45.5"]);
    expect(valueTokens("v2.10.3 or 02.1.3", "version")).toEqual(["2.10.3", "2.1.3"]);
    expect(valueTokens("7:05 then 23:59", "time")).toEqual(["07:05", "23:59"]);
    expect(valueTokens("CH-42, Zone A3, F123, SEV-2", "code")).toEqual(["42", "a3", "f123", "2"]);
    expect(valueTokens("anything 42", "text")).toEqual([]);
  });

  it("codeCore", () => {
    expect(codeCore("CH-42")).toBe("42");
    expect(codeCore("SEV-2")).toBe("2");
    expect(codeCore("Zone A3")).toBe("a3");
    expect(codeCore("F123")).toBe("f123");
    expect(codeCore("no digits")).toBe("no digits");
  });

  it("candidates are distinct and exclude question values", () => {
    const p = P("int", "450", [], "grounded", "Rating of facility Brakel-42?");
    expect(candidates(p, "Brakel-42: 450, i.e. 450 kW")).toEqual(["450"]);
    expect(candidates(p, "450 or 460")).toEqual(["450", "460"]);
    expect(candidates(P("text", "line lead", ["electrician"]), "electrician, not line lead")).toEqual(["line lead", "electrician"]);
  });
});

describe("checkGrounding", () => {
  const sources = ["Generator rating: 450 kW. Fuel autonomy 1,200 hours.", 'Ops note: "Restart the relay at dawn" per SOP 7.2.'];

  it("supports numbers present in the sources (comma-insensitive)", () => {
    expect(checkGrounding("Rated 450 kW with 1200 hours of fuel; see SOP 7.2.", sources)).toEqual({ supported: true, unsupported: [], checked: 3 });
    expect(checkGrounding("Fuel lasts 1,200 hours", sources).supported).toBe(true);
  });

  it("flags invented numbers, deduplicated", () => {
    expect(checkGrounding("Rated 451 kW, 451 kW, and 450 kW", sources)).toEqual({ supported: false, unsupported: ["451"], checked: 3 });
  });

  it("does not accept a number that only appears as part of a larger one", () => {
    expect(checkGrounding("45 kW", sources).unsupported).toEqual(["45"]);
    expect(checkGrounding("7 is the SOP", sources).unsupported).toEqual(["7"]);
  });

  it("checks straight and curly quotes case-insensitively", () => {
    expect(checkGrounding('They said "restart the relay at dawn".', sources).supported).toBe(true);
    expect(checkGrounding("They said “Restart the relay”.", sources).supported).toBe(true);
    expect(checkGrounding('They said "shut down the plant"', sources)).toEqual({ supported: false, unsupported: ["shut down the plant"], checked: 1 });
  });

  it("ignores reasoning blocks", () => {
    expect(checkGrounding("<think>maybe 999?</think>It is 450 kW", sources)).toEqual({ supported: true, unsupported: [], checked: 1 });
  });

  it("ignores short quotes and plain text; with no sources any figure is unsupported", () => {
    expect(checkGrounding('A "yes" answer with no figures.', sources)).toEqual({ supported: true, unsupported: [], checked: 0 });
    expect(checkGrounding("42", [])).toEqual({ supported: false, unsupported: ["42"], checked: 1 });
  });
});

describe("scoreAnswer on generated probes", () => {
  it("the verbatim reference scores correct on (almost) every grounded probe", () => {
    let n = 0;
    for (let seq = 0; seq < 600; seq++) {
      const p = generateProbe(1, seq, { bands: [400] });
      if (p.kind !== "grounded") continue;
      n++;
      expect(scoreAnswer(p, p.reference).outcome, p.id).toBe("correct");
    }
    expect(n).toBe(400);
  });

  // Regression (fixed): candidates() drops every value that also appears in the question, to ignore
  // entity names like "Brakel-42". When the entity number equals the asked value
  // (facility "Salfenvin-29" with 29 loading docks; facility "Peltirkel-63" on CH-63),
  // the verbatim correct answer has no candidates left and scores "hallucinated".
  // ~0.15% of grounded probes (4 of 2668 for seed 1, seqs < 4000).
  it("a correct answer equal to a number in the entity name scores correct", () => {
    const docks = generateProbe(1, 976, { bands: [400] });
    expect(docks.question).toContain("Salfenvin-29");
    expect(docks.reference).toBe("29");
    expect(scoreAnswer(docks, "29").outcome).toBe("correct");
  });

  it("a correct channel equal to the entity number scores correct", () => {
    const ch = generateProbe(1, 2512, { bands: [400] });
    expect(ch.reference).toBe("CH-63");
    expect(scoreAnswer(ch, "CH-63").outcome).toBe("correct");
  });
});
