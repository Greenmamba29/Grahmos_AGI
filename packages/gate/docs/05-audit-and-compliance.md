# 05: Audit and compliance

Audience: compliance and security staff, and whoever assembles evidence for a gate claim, investor diligence, or a regulator. This manual covers `gate-harness@0.5.0`.

> **Not legal advice.** Section 8 maps GATE artifacts to the *kinds* of evaluation and record-keeping obligations in frontier-AI rules, at a high level. These laws are still being amended and clarified. Confirm applicability with counsel.

---

## 1. What the chain records

`AuditLog` (`src/audit.ts`): append-only JSONL. Each entry is `{ seq, ts, type, payload, prevHash, hash }`, where

- `hash = SHA-256(prevHash + "\n" + canonicalJSON({seq, ts, type, payload}))`, or
- HMAC-SHA256 of the same material when `GATE_AUDIT_KEY` is set.

Entries are written to disk as they are produced.

| Type | Count (demo: 783 total) | Payload |
|---|---|---|
| `evaluation_start` | 1 | `harness` (`gate-harness@0.5.0`), `chain` (`sha256` \| `hmac-sha256`), `suite`, **`agents` with `kind`** (e.g. `{"name":"sim:frontier","kind":"code"}`), `repeats`, `seed`, `bootstrap`, `ridge`, `policy`, **`sealed`** (true when files were written), and the **full gate definitions** |
| `suite_start` | 1 per agent | Per task: `id`, `humanMinutes`, `messiness`, `holdout`, **`specSha256`**. Plus `repeats`, `seed`, `maxSteps`, `timeoutMs`, and detector config |
| `run` | 768 | `runId`, outcome fields, flags, `stepCount`, `timedOut`, `trajectorySha256`, `error?`, `errorKind?` |
| `suite_end` | 1 per agent | Run count |
| `metrics` | 1 per agent | `runs`, `infraErrors`, `counts`, horizon estimates, and **per gate `status` with each requirement's metric, observed value and status** |
| `evaluation_end` | 1 | `runs`, **`recordsSha256`**: a digest of every record's `{runId, naivePass, cleanPass, claim, cheated, trajectorySha256}` |
| `artifacts` | 1 (last) | SHA-256 of `results.json`, `report.md` and `report.html`. This is **the seal**. |
| `evaluation_aborted` | only on abort | Written when a `ConfigError` (HTTP 401/403/404) aborts the evaluation: `{ agent, error }`. The log then ends without a seal, so `gate verify` reports `log ends with "evaluation_aborted", expected artifacts` and the folder can never pass as evidence. |

**`specSha256`** (`taskSpecHash`) covers id, title, family, prompt, humanMinutes, messiness, holdout, maxSteps, files, protectedPaths, hidden-file contents, and **the source text of `grade` and `check`**. Verified:

- Changing a grader's `details` string changed the hash.
- Changing a module-level constant the grader closes over did **not** change it.

Pin the suite source by commit hash as well.

**`trajectorySha256`** excludes timing. Two runs with the same seed produce identical trajectory hashes and identical records digests.

**The final head vs the report's head.** The CLI prints the final head after every run (`Final audit head (anchor this somewhere you control): …`). That is the hash of the `artifacts` entry, and it is the one to anchor. `report.md` and `report.html` show the head *before* the seal, because they are themselves sealed by the final entry. The report says so: `head before the final seal … — do not anchor this one`.

## 2. What is proven, and what is not

| Proven (under the stated conditions) | Not proven |
|---|---|
| **`gate verify <dir>` OK:** the chain is intact from genesis and **ends with the `artifacts` seal** (always required for folders); the three files match their sealed hashes; every run's transcript and outcome match the log; run counts agree; **every agent saw identical task specs**; the records digest matches. | **Unkeyed with no anchored head: authenticity.** A complete forgery of a folder still passes the consistency checks (verified below). The CLI therefore exits 1 ("NOT CERTIFIED") unless `--allow-unkeyed` is passed. |
| **Recomputation (on by default; `--no-recompute` skips it):** the metrics and the PASS/INSUFFICIENT/FAIL verdicts follow from the records under the logged configuration (gates, seed, bootstrap, ridge), including the mixed-evaluation downgrade. | That the harness itself was unmodified. |
| **With HMAC (`--require-hmac`):** the writer held the key, and nobody without the key changed anything. | Integrity of **code agents**: in-process code can patch process globals (manual 03, section 3.4). Their verdicts are never certifiable. |
| **With `--expect-head`:** this exact log, not truncated, not rewritten. | Calibrated `humanMinutes`; no contamination; unchanged grader closures. |
| The configuration used, and that the suite did not change between agents. | Wall-clock truth of `ts`. |

### 2.1 Verified behavior

Head values come from single demo runs; your heads will differ. `<H>` stands for the true final head.

| Manipulation | Result |
|---|---|
| None, `verify <dir> --expect-head <H>` | `OK`, `checks run:` with 6 `·` lines (the last: `recomputed metrics and gate verdicts for 4 agent(s)`), exit 0 |
| None, `verify <dir>` (no key, no head) | `OK` … then `NOT CERTIFIED: unkeyed check with no --expect-head …`, **exit 1** |
| None, with `--allow-unkeyed` | `OK` … then `WARNING: …`, exit 0 |
| Flip `"cheated":true` → `false` in the first cheated run entry (line 369) | file form: `BROKEN at entry 368: hash mismatch at entry 368 (content altered or wrong key)`; dir form: `FAILED ✗ hash mismatch at entry 368 …` |
| Delete line 11 | `BROKEN at entry 10: expected seq 10, found 11` |
| Truncate to 500 lines, file form | `BROKEN: log ends with "run", expected artifacts: it may be truncated` (the seal is required because `evaluation_start.sealed` is true). With `--allow-partial`: `OK: 500 entries …, last entry "run" (partial log accepted)` plus the warning. With `--allow-partial --expect-head <H>`: `BROKEN: head … does not match the expected head <H>`. |
| Truncate to 500 lines, dir form | `FAILED ✗ log ends with "run", expected artifacts: it may be truncated` |
| Remove the key read from a cheated run's transcript in `results.json`, mark it clean | `✗ results.json does not match the hash sealed in the audit log` · `✗ run sim:frontier::release-plan::3: transcript differs from the logged hash` · `✗ … cheated is false in results.json but true in the audit log` · `✗ records digest does not match evaluation_end` |
| Edit one number in `report.md` | `✗ report.md does not match the hash sealed in the audit log` |
| Delete `results.json` | `✗ results.json is missing` |
| Folder of a run aborted by HTTP 401 | `FAILED` … `✗ log ends with "evaluation_aborted", expected artifacts: it may be truncated` |
| **Verdict forgery:** set `sim:frontier` S1 to `pass` in `results.json` and in the `metrics` entry, re-seal, re-chain (unkeyed) | Default: `FAILED` … `problems:` `✗ sim:frontier gate S1: recomputed insufficient, logged pass`, exit 1. Only with `--no-recompute` does it print **`OK`**. |
| **Full unkeyed forgery** (edit a record, patch its run entry, recompute the digest and seal, re-chain; `workshop/forge-folder.ts`, ~30 lines) | `OK` but `NOT CERTIFIED`, exit 1. With `--allow-unkeyed`: `OK`, exit 0. **The forgery is consistent.** With `--expect-head <H>`: `✗ head … does not match the expected head <H>` |
| The same forgery on an HMAC folder (attacker has no key) | `✗ hash mismatch at entry 0 (content altered or wrong key)` |
| HMAC folder, no key | `✗ hash mismatch at entry 0 …`; with `--require-hmac`: `✗ an HMAC key is required to verify this log` |

Output format: `OK` or `FAILED`, then `checks run:` with `· <check>` lines, then `problems:` with `✗ <problem>` lines. A check listed under "checks run" only ran; the problems list says what failed. Read the first line and the exit code.

**Conclusion.** For any external claim, use HMAC (key not held by the operator), **and** anchor the final head, **and** have an independent verifier run:

```bash
GATE_AUDIT_KEY=… npx tsx bin/gate.ts verify <dir> --require-hmac --expect-head <anchored head>
```

Recomputation is on by default. Never pass `--no-recompute` for a claim.

## 3. Verification API

```ts
verifyAuditLog(jsonl, hmacKey?, { requireHmac?, expectHead?, requireLastType? }): VerifyResult   // { ok, count, head, brokenAt?, reason?, lastType? }
verifyEvidence(dir, hmacKey?, { requireHmac?, expectHead?, recompute? }): { audit, problems, checked, ok }
```

`verifyEvidence` always requires `artifacts` as the last entry; it never infers sealing from which files exist. The file form in the CLI requires `artifacts` when `evaluation_start.sealed` is true, and `evaluation_end` or `artifacts` otherwise, unless `--allow-partial` is given.

**Spec check against your suite source** (not covered by `verifyEvidence`), `workshop/spec-check.ts`:

```ts
// Usage: npx tsx workshop/spec-check.ts <run-dir> [suite-module]
// Checks that every task spec hash logged in suite_start matches the suite source you hold.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { exampleSuite, taskSpecHash, type AuditEntry, type Task } from "../src/index.js";

const [dir = "runs/manual-demo", suiteArg] = process.argv.slice(2);
const tasks: Task[] = suiteArg ? ((await import(pathToFileURL(resolve(suiteArg)).href)).suite as Task[]) : exampleSuite;
const specs = new Map(tasks.map((t) => [t.id, taskSpecHash(t)]));
const entries = readFileSync(`${dir}/audit.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);
const logged = entries.filter((e) => e.type === "suite_start").flatMap((e) => (e.payload as { tasks: { id: string; specSha256: string }[] }).tasks);
const changed = [...new Set(logged.filter((t) => specs.get(t.id) !== t.specSha256).map((t) => t.id))];
console.log(`task specs: ${logged.length - logged.filter((t) => changed.includes(t.id)).length}/${logged.length} match the suite source${changed.length ? `; changed: ${changed.join(", ")}` : ""}`);
```

Demo: `task specs: 64/64 match the suite source`. After a grader text edit: `task specs: 0/1 match the suite source; changed: mesh-config-fix`.

## 4. HMAC key management

| Practice | Why |
|---|---|
| `openssl rand -hex 32` | Key entropy |
| Store in a secret manager; inject `GATE_AUDIT_KEY` at run time only | Keeps it out of history, the repo and `--out` |
| **Separate duties:** the key holder is not the operator | Otherwise HMAC only proves the operator wrote the log |
| Record a key id (e.g. the first 8 hex digits of `sha256(key)`), never the key | Supports verification and rotation |
| Rotate on personnel change; escrow retired keys for the retention period | Old logs need their write-time key |
| Verify with `--require-hmac` | A missing key is a failure |
| HMAC verification is symmetric | Third parties without the key rely on the anchored head, or on an asymmetric signature over the head (not built in) |

## 5. Evidence packs and retention

Archive the following, immutably:

| Item | Source |
|---|---|
| The `--out` folder (all four files) | the run |
| The CLI output of the run, including the **final head** | the run |
| The independent verifier's `gate verify <dir> --require-hmac --expect-head <H>` output and exit code | the verifier |
| Command line and environment (no secrets) | run notes; much of it is in `evaluation_start` and `suite_start` |
| Harness commit hash | `git rev-parse HEAD` |
| Suite source and version; holdouts in restricted storage; spec-check output | suite repo |
| Human-baseline records | manual 02, section 7 |
| Model identity, server and version, sampling parameters | run notes |
| Head anchor (where and when); HMAC key id | section 2 |
| Infra-error count and causes | `metrics.infraErrors`, `records[].error` |
| Triage log; detector severity overrides with justification | manual 03, section 7 |
| Sign-off memo with the **Certifying S1 checklist** (section 6) | research lead |

**Retention.** Set it with counsel. As a reference point, EU GPAI documentation is expected to remain available for 10 years under the Code of Practice. Redact only copies: redacting the original breaks the seal.

## 6. Certifying S1: evidence checklist

These are the independent reviewer's conditions (the same as manual 04, section 9). Each one maps to evidence in the pack:

| Condition | Evidence |
|---|---|
| ≥ 8 high-messiness tasks from ≥ 8 distinct families in 8–16 h | `results.json` → S1 horizon requirement `atThreshold.tasks` ≥ 8, and no "need 8 distinct families" note; suite source; baseline records |
| Real timed human baselines for those tasks | Baseline records with spec hashes matching `suite_start` |
| ≥ 12 repeats per task | `evaluation_start.repeats` |
| ≥ 149 scored runs | `metrics.runs` (the S1 cheat note shows `k/n`) |
| Zero infra errors on window tasks; total infra ≤ 5% | No "lost to infrastructure errors" note on the requirement or the gate; `metrics.infraErrors` |
| A model agent, evaluated on its own | `evaluation_start.agents` = one entry with `"kind":"model"`; no "evaluated alongside in-process code agents" note |
| S1 status `pass` | `metrics.gates[S1].status`, confirmed by the verifier's default recomputation |
| HMAC + anchored head + independent verifier | `chain: "hmac-sha256"`; the anchor record; the verifier's output: `OK`, exit 0, with `--require-hmac --expect-head` (no `--no-recompute`) |
| Claim wording per manual 04, section 9 | Sign-off memo |

## 7. Remaining limits (state these in any external claim)

1. Unkeyed logs without an anchored head prove consistency only.
2. Code agents are trusted and their verdicts are not certifiable. Model agents must be certified in evaluations of their own.
3. The sandbox is not OS isolation; there is no container layer.
4. Grader closures are not hashed.
5. `ts` is local time. Timestamp the anchored head externally (for example with RFC 3161) if time matters.
6. A PASS certifies "≈ 80% or better". An agent plateauing at 79% passes S1 about 17% of the time (manual 04, section 8.2).

## 8. Regulatory mapping (high level, not legal advice)

These regimes mostly target **developers of frontier or general-purpose models** above compute or revenue thresholds. A company that deploys or evaluates others' models may have no direct obligations under them. Even so, they show what evaluation evidence counterparties will expect.

### 8.1 EU AI Act: GPAI models

- **Dates.** GPAI provider obligations applied from 2 August 2025 for new models. Commission enforcement begins 2 August 2026. Models already on the market have until 2 August 2027. A voluntary Code of Practice offers a recognized compliance route.
- **Art. 53 / Annex XI.** Technical documentation, including for systemic-risk models a "detailed description of the evaluation strategies, including evaluation results", with "evaluation criteria, metrics and the methodology on the identification of limitations", plus adversarial testing.
- **Art. 55.** Model evaluation including adversarial testing, risk mitigation, serious-incident reporting, and cybersecurity.
- **GATE contributes:** a documented methodology, exact-bound verdicts with stated limitations (calibration, plateau, under-coverage), tests of the evaluation itself (calibrate, red-team, `selfTest`), and sealed, recomputable records.
- **GATE does not cover:** dangerous-capability evaluations, or the documentation forms themselves.

### 8.2 California SB 53

- Signed September 2025. It covers frontier developers (> 10^26 operations) and large frontier developers (> $500M revenue).
- Obligations include a frontier AI framework, transparency reports at release, critical-safety-incident reports to Cal OES within 15 days (24 h for imminent risk), whistleblower protections, and Attorney General enforcement.
- **GATE contributes:** evaluation records a framework can reference; cheating-as-failure and awareness metrics; verifiable packs for third-party evaluators.

### 8.3 New York RAISE Act

- Signed December 2025. Chapter amendments align it largely with SB 53, with a reported effective date of 1 January 2027. It covers large frontier developers.
- Obligations include a safety framework, transparency reporting, critical-incident reports within 72 hours, oversight by an office within NY DFS, and Attorney General enforcement (reported as up to $1M for a first violation and $3M thereafter).
- Earlier drafts required retaining test records. Confirm what the final text keeps.

### 8.4 Practical mapping

| Common expectation | GATE artifact |
|---|---|
| Methodology and metrics | Manuals 02–04; gates in `evaluation_start` |
| Stated limitations | Verdict notes, calibration and plateau caveats, manual 00 table |
| Results not inflated by gaming | Naive vs integrity, detector counts, triage |
| Testing the evaluation | `gate calibrate`, detector red-team, `selfTest` |
| Record integrity and retention | HMAC + anchored head + `gate verify` (recomputing) + evidence pack |
| Third-party evaluation | Portable folder; the verifier needs the key or the anchored head |
| Incident identification | Partial: critical flags are signals for your incident process |

Sources consulted (October 2026), all secondary summaries; verify against the primary texts:

- EU AI Act Annex XI: https://artificialintelligenceact.eu/annex/11/
- Latham & Watkins on GPAI obligations and the Code of Practice: https://www.lw.com/insights/eu-ai-act-gpai-model-obligations-in-force-and-final-gpai-code-of-practice-in-place
- Mayer Brown on SB 53 (Oct 2025): https://www.mayerbrown.com/en/insights/publications/2025/10/california-enacts-sb-53-creating-new-requirements-for-developers-of-frontier-artificial-intelligence-models-and-related-whistleblower-provisions
- RAISE Act overview: https://en.wikipedia.org/wiki/Responsible_AI_Safety_and_Education_Act
- JD Supra on the RAISE Act's final form: https://www.jdsupra.com/legalnews/new-york-finalizes-raise-act-for-8270433/
