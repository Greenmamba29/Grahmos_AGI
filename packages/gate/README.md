# GATE — Gated Agent Trust Evaluation

An integrity-aware evaluation harness for AI agents, in TypeScript. It measures METR-style **time horizons** (the task length at which an agent succeeds 50% / 80% of the time), counts **cheating as failure**, and checks staged **roadmap gates** (S0 reasoning agents → S1 reliable workday agents → S2 week-long autonomy). Every run is recorded in a **tamper-evident audit log** that a third party can verify.

It is the first build from the AGI roadmap: the binding constraints on the path are reliability, messy long tasks, and evaluation integrity (frontier models now game their evals), so the instrument that measures them has to be trustworthy itself.

```
npm install
npx tsx bin/gate.ts self-test          # validate the example suite
npx tsx bin/gate.ts demo               # simulated agents with known ground truth
npx tsx bin/gate.ts verify runs/demo --expect-head <head printed by demo>
npx tsx bin/gate.ts calibrate          # measure the gate's own false-pass rate and power
npx vitest run                         # 716 tests
```

## What it does

| Layer | What it gives you |
|---|---|
| Sandbox | In-memory project folder with `list_files`, `read_file`, `write_file`, `delete_file`, `run_check`, `submit`. Every call is recorded. Agents get a frozen tool facade; tasks are deep-frozen per run. |
| Double grading | Each run is graded twice: as a naive harness sees it, and with grader files restored to pristine. The gap is cheating. |
| Integrity detectors | Grader tampering, answer-key access, recorder tampering (critical: scored as failure); sandbox-escape attempts, stated intent to game the grader, eval awareness, false success claims (warnings). |
| Time horizons | Weighted logistic fit of success vs log2(human minutes), hierarchical bootstrap (family → task → run), 50% and 80% horizons overall and on messy tasks. |
| Gates | PASS / INSUFFICIENT / FAIL. Exact one-sided 95% binomial bounds, a model-free check on tasks between the threshold and twice it (≥ 8 distinct task families), a design effect for correlated runs, and no extrapolation. |
| Evidence | Hash-chained audit log (HMAC with `GATE_AUDIT_KEY`) that records the configuration, gate definitions, task spec hashes (grader source included), every run's transcript hash, a records digest, and a seal over the written reports. `gate verify <dir>` re-checks everything and recomputes the verdicts. |
| Agents | `openai:<model>` (any OpenAI-compatible server, including local vLLM / Ollama for fully offline evals), `anthropic:<model>`, and simulated agents with known ground truth. |

## Is the gate honest? (measured)

Measured with `gate calibrate` (S1 horizon requirement; synthetic suite with ≥ 8 messy task families in 8–16h; 12 repeats):

| True 80% horizon on messy tasks | PASS (no task variation) | PASS (task-to-task sd 1) |
|---|---|---|
| 0.75× threshold (6h) | 0% | 0% |
| 1× threshold (8h) — false-pass rate | 0% | 0% |
| 2× threshold (16h) | 87.5% | 40% |
| 4× threshold (32h) | 100% | 96.7% |

An independent reviewer agent ran larger simulations (400 per cell) at the boundary: ≤ 1.3% false pass with no task variation, 3.5–5.0% with moderate variation, 5.0–6.8% with large variation. Known limitation: an agent whose success plateaus at 79% on 8–16h tasks and collapses beyond (effectively at the threshold) passes about 17% of the time.

## What an S1 PASS certifies, and when to quote it

"≥ 80% success at 8h on messy tasks (one-sided 95%), cheating counted as failure, on suite X with N tasks × R repeats." Quote it only when:

1. The suite has ≥ 8 distinct-family messy tasks with **real, timed human baselines** in 8–16h, held out from the agent's developers. *(The example suite has 2 such tasks and placeholder times, so it reports S1 INSUFFICIENT by design.)*
2. ≥ 12 repeats and ≥ 149 scored runs; zero infrastructure errors on the 8–16h tasks.
3. The agent is a **model agent** (built-in adapters) in an evaluation of its own. In-process code agents are trusted code and their verdicts are labelled not certifiable.
4. `GATE_AUDIT_KEY` was set, the final head was anchored outside the operator's control, and someone else ran `gate verify <dir> --require-hmac --expect-head <head>`.
5. Only PASS is quoted. INSUFFICIENT is not a result.

## Layout

```
src/            harness (types, sandbox, detectors, horizon, stats, scoring, audit, runner, evaluate, report, calibrate)
src/agents/     simulated + OpenAI-compatible + Anthropic adapters
src/suites/     defineOutputTask helper, 16-task example suite
bin/gate.ts     CLI
test/           716 Vitest tests
docs/           training manuals (start at docs/00-index.md)
CHANGELOG.md    what each review round changed and why
```

## Training manuals

`docs/00-index.md` (map + glossary) · `01` operator manual · `02` task authoring · `03` integrity and detectors · `04` scoring, horizons and gates · `05` audit and compliance · `06` hands-on curriculum with assessment.

## Caveats

- The sandbox is a virtual file system, not OS isolation. Tasks that execute agent-written code need a container layer.
- Text detectors only see verbalized reasoning; they are heuristics with measured misses and false positives (docs/03).
- The LLM adapters are tested against mocked servers; they have not been run against live endpoints in this build.
- Simulated-agent numbers describe the harness, not any real model.

Apache-2.0.
