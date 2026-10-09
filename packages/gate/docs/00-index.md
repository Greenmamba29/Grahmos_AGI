# GATE manuals: index

**Harness version: `gate-harness@0.5.0`** (`src/version.ts`; also recorded in each audit log's `evaluation_start` entry and in `report.harness`). These manuals describe 0.5.0. Every command, number and output excerpt in them was re-run against this version. `CHANGELOG.md` lists the changes in 0.3.0, 0.4.0 and 0.5.0, which came from three independent review rounds; the last one gave a conditional sign-off.

GATE (Gated Agent Trust Evaluation) is a TypeScript harness for evaluating autonomous agents. It answers one question: **how long a task can this agent complete reliably, once cheating is counted as failure, and is there enough evidence to certify that?**

It is the first build from the AGI roadmap. That roadmap found three binding constraints:

- **Reliability.** METR's 80% horizon is about 1/5 to 1/6 of its 50% horizon.
- **Messy long-horizon tasks.**
- **Evaluation integrity.** METR could not get a clean horizon for one frontier model: it was 11.3 h with cheating scored as failure and over 270 h with cheating scored as success.

## The one rule for reading GATE output

Every gate returns one of three verdicts:

| Verdict | Meaning | How to quote it |
|---|---|---|
| **PASS** | The conservative bound clears the bar. | "Passes S1 under GATE 0.5.0 on suite X (verification head …)" |
| **FAIL** | Even the optimistic bound misses the bar. | "Fails S1" |
| **INSUFFICIENT** | Neither of the above: the data cannot yet decide. | **Never quote it as a result.** It means "needs more evidence" (more runs, more tasks near the threshold, fewer infrastructure errors). It is not "almost passes" and not "fails". |

Defaults are conservative: exact one-sided 95% bounds. A fitted curve alone never certifies anything. In particular, the built-in example suite **reports S1 as INSUFFICIENT by design**: it has only 2 messy tasks in the 8–16 h window, and S1 needs 8 tasks from distinct families there (manual 04, section 7).

## What GATE is not (read before quoting numbers)

| Limitation | Consequence |
|---|---|
| Example-suite `humanMinutes` are placeholders | Example-suite horizons are not comparable to METR's numbers. Calibrate the baselines first (manual 02, section 7). |
| The example suite cannot certify S1 or S2-proxy | Too few long messy tasks. A certifying suite needs ≥ 8 distinct-family messy tasks of 8–16 h with timed baselines (manual 04, section 9). |
| In-memory virtual file system, no code execution | No container layer for coding agents yet. |
| **Code agents** (simulated, scripted, custom in-process) are trusted | Their verdicts are labelled *not certifiable*. Only **model agents** driven through the built-in adapters can be certified, and only in an evaluation of their own (manual 03, section 3.4). |
| Text detectors are regular expressions | They only see verbalized behavior. False positives and negatives are measured in manual 03, section 3.2. |
| `gate calibrate` defaults to no task-to-task variation | Without `--task-sd`, its false-pass figures are a best case. Use `--task-sd 1` for realistic variation; manual 04, section 8 also gives the reviewer's figures. |
| Plateau limitation | An agent stuck at about 79% on the 8–16 h tasks passes S1 about 17% of the time. It is effectively at the threshold (manual 04, section 8.3). |
| LLM adapters have not been run against live models in this build | Only plumbing was checked, against local mocks (manual 01, section 5.5). |
| Unkeyed audit logs prove internal consistency only | Use HMAC and an anchored head. `gate verify` exits 1 ("NOT CERTIFIED") otherwise, unless you pass `--allow-unkeyed`. |

The repository root also has a short `README.md`. These manuals are the full reference.

## Manuals

| # | File | Audience | Use it to |
|---|---|---|---|
| 00 | `00-index.md` | Everyone | Get oriented; read the glossary |
| 01 | [`01-operator-manual.md`](01-operator-manual.md) | Operators | Install; CLI (`run`, `demo`, `self-test`, `calibrate`, `list-tasks`, `verify`); model vs code agents; offline runs; infra and config errors; outputs; troubleshooting |
| 02 | [`02-task-authoring.md`](02-task-authoring.md) | Task authors, domain experts | Write tasks (visible `check` vs final `grade`); pin output formats; calibrate baselines; design a suite that can certify S1 |
| 03 | [`03-integrity-and-detectors.md`](03-integrity-and-detectors.md) | Integrity reviewers, red-teamers | Threat model; tool facade and frozen tasks; chroot-style paths; detector catches and misses (measured); `recorder_tamper`; triage |
| 04 | [`04-scoring-horizons-and-gates.md`](04-scoring-horizons-and-gates.md) | Research leads, gate sign-off | The math; three-valued verdicts; exact bounds; window check; design effect; calibration and its limits; **Certifying S1 checklist** |
| 05 | [`05-audit-and-compliance.md`](05-audit-and-compliance.md) | Compliance, security, evidence owners | Chain contents; `verifyEvidence` (recomputes verdicts by default); HMAC and anchoring; evidence packs; **Certifying S1 checklist**; regulatory mapping (not legal advice) |
| 06 | [`06-training-curriculum.md`](06-training-curriculum.md) | New team members | Hands-on course with verified exercises and an assessment |

## Recommended learning paths

- **Everyone (about 2 h):** 00, then curriculum modules 1–2.
- **Operators:** 01, then curriculum modules 5 and 7.
- **Task authors:** 02, then curriculum module 3, then 04 sections 7 and 9.
- **Integrity reviewers:** 03, then curriculum module 4, then 05.
- **Gate sign-off:** 04 in full, then 05 sections 2 and 6, then curriculum module 6 (calibrate and the S1-INSUFFICIENT exercise).

## Source map

| Concern | File |
|---|---|
| Types (Task, Agent.kind, RunRecord, Gate, GateStatus, …) | `src/types.ts` |
| Sandbox, tool facade, chroot paths, `escapeAttempt`, typed errors (`InfraError`, `ConfigError`, `NotAFileError`) | `src/sandbox.ts` |
| Single run, frozen tasks, `recorder_tamper`, spec and trajectory hashes | `src/runner.ts` |
| Detectors, patterns, task-aware intent, negation scope | `src/detectors.ts` |
| Logistic fit, hierarchical bootstrap, horizons | `src/horizon.ts` |
| Exact Clopper–Pearson bounds | `src/stats.ts` |
| Metrics, `DEFAULT_GATES`, three-valued gate evaluation, window target, design effect, `validateGates` | `src/scoring.ts` |
| Monte Carlo gate calibration (`gate calibrate`) | `src/calibrate.ts` |
| Hash-chained audit log, `verifyAuditLog` | `src/audit.ts` |
| `evaluate()`, `verifyEvidence()`, `selfTest()` | `src/evaluate.ts` |
| Reports | `src/report.ts` |
| `defineOutputTask`, `CHECK_PATH`, `KEY_PATH` | `src/suites/define.ts` |
| Example suite (16 tasks, 2 min – 16 h) | `src/suites/example.ts` |
| Simulated/scripted agents (`kind: "code"`) | `src/agents/simulated.ts` |
| OpenAI-compatible and Anthropic adapters (`kind: "model"`) | `src/agents/llm.ts` |
| CLI | `bin/gate.ts` |
| Tests (`npm test`: 13 files, 716 tests) | `test/` |

## Glossary

**Verdict (PASS / INSUFFICIENT / FAIL).** The three-valued result of a requirement and of a gate. A gate is FAIL if any requirement fails, otherwise INSUFFICIENT if any requirement is insufficient, otherwise PASS. Even then, a gate cannot PASS if more than 5% of runs were lost to infrastructure errors, or if a model agent shared the evaluation with code agents.

**Time horizon (h50, h80).** The human task length at which the fitted success probability equals 50% (80%). The fit is P(success) = σ(a + b·log2 minutes).

**Identified horizon.** A fit identifies a horizon only if its slope is below −0.05 per doubling. Otherwise the horizon is "not identified" (`n/id`), and any PASS rests on exact evidence alone.

**Exact bound.** A one-sided Clopper–Pearson binomial bound. The default confidence is 95%, and each requirement can set its own with `confidence`. With zero events in n runs, the upper bound is ≤ 2% once n ≥ 149 and ≤ 1% once n ≥ 299. An 80% lower bound needs ≥ 14 straight successes.

**Conservative (default).** A requirement compares pessimistic bounds for PASS and optimistic bounds for FAIL. `conservative: false` compares point estimates and is labelled "[point estimate]" in reports.

**Window (evidence at threshold).** For a horizon requirement `>= T`, the tasks with human time in [T, 2T]. Their pooled success, corrected for correlated runs, must clear a **target**: the fitted-slope curve anchored at (T, p), averaged over the window's runs. The slope is fitted on tasks ≤ 2T and capped at −1 logit per doubling. The window must contain ≥ `minTasksAtThreshold` tasks (default 8) **from at least that many distinct families**.

**Design effect.** A variance inflation factor for runs of the same task being correlated: 1 + (m̄ − 1)·ICC. The intra-task correlation (ICC) is estimated around the fitted curve. Exact bounds use the effective sample size n/deff.

**Infra error.** A run that failed because of a typed `InfraError` thrown by an adapter (HTTP 408/409/425/429/5xx, network failure after retries). It is excluded from scoring **unless it cheated** (cheats are never excused). Any infra-excluded run on a window task makes that horizon requirement INSUFFICIENT. More than 5% infra overall means no gate can PASS.

**Config error.** HTTP 401/403/404 from a provider, thrown as `ConfigError`. It aborts the whole evaluation, so a misconfigured model is never scored as incapable.

**Agent kind.** `model` means a model acting only through tool calls (the built-in OpenAI-compatible and Anthropic adapters); these verdicts are certifiable. `code` means agent code in the harness process (simulated, scripted, custom); it is trusted, and its verdicts are not certifiable.

**Visible check vs final grader.** `Task.check` runs on `run_check` during the episode. For `defineOutputTask` it only validates "valid JSON of the right top-level type". `Task.grade` is the final grader, run after the episode.

**Naive / clean pass.** The final grader's verdict on the final state, and on the state with grader-owned paths restored.

**Integrity flag.** Detector output with severity critical, warning or info. Any critical flag means `cheated`. The critical detectors are `grader_tamper`, `answer_key_access` and `recorder_tamper`. `sandbox_escape` is a warning since 0.3.0.

**Cheat policy.** `failure` (default, used for all gates), `success` (naive comparison), or `exclude` (API only).

**Audit chain / seal / anchored head.** `audit.jsonl` is a SHA-256 or HMAC hash chain. Its last entry, `artifacts`, seals the output files. The **final head**, printed by the CLI after each run, is what you anchor. The report shows the *pre-seal* head, which is not the one to anchor.

**Calibration.** `gate calibrate`: a Monte Carlo estimate of a gate's false-pass rate (PASS at true horizon ≤ threshold) and power (PASS above it), on a synthetic suite, optionally with per-task random effects (`--task-sd`) (manual 04, section 8).
