# @grahmos/sentinel: continuous hallucination monitoring

Sentinel probes the local model whenever the box is idle. It detects when a **hallucination episode begins and ends**, and attaches each episode to the model, checkpoint, quantization and host conditions it happened under. The evidence for all of this is kept in a hash-chained audit log.

```bash
pnpm sentinel:demo                      # simulated model, known episodes, checks detection against truth
pnpm sentinel bench --seeds 10          # detection accuracy vs ground truth
SENTINEL_MODEL=qwen3.6-27b pnpm sentinel run --max-context 32768 --no-thinking
```

## How it works

1. **Probes.** Each probe is one record about fictional GrahmOS operations (a facility, mesh node, incident or roster entry) plus one question. The record is padded with look-alike records to a target prompt size of 1k, 4k, 16k or 32k tokens, sized conservatively at 3 chars/token.
   - About a third of the questions are *unanswerable*: the record omits the asked field, and the only correct reply is `NOT IN DOCUMENT`.
   - The values are invented, so the model cannot answer from world knowledge.
   - Padding records never share the target's value for the asked field, so a borrowed value is always wrong.
2. **Scoring** is typed by value kind:
   - Integers: `1,200` = `1200`, `450kW` = `450`, `45.5` ≠ `45`.
   - Versions must match exactly. Times are zero-padded (`7:05` = `07:05`).
   - Codes match on their core value: `CH-42` = `channel 42`, and `Zone A3` ≠ `B3`.
   - **Hallucinated:** a wrong value, two different values ("450 or 460"), or any concrete value for an unanswerable question, even next to an abstention.
   - **Invalid:** empty replies, replies cut off at the token limit, server rejections and reasoning-only output. These are counted, never charted.
3. **Streams**, per model:
   - `model|1k`, `model|4k`, `model|16k`, `model|32k`;
   - `model|all`, where every band is tested against its own baseline (stratified), so mixing bands never raises an alarm by itself;
   - `model|live`, for grounding checks on real traffic via `POST /observe`.
4. **Detection** uses a Bernoulli CUSUM per stream.
   - The **baseline** is learned during warmup: 100 observations, and at least 60 per band on `|all`. Each band's baseline is shrunk toward the stream's pooled rate.
   - The **alarm** fires when the rate rises to max(2×baseline, baseline + 10 points).
   - **Onset and end** are maximum-likelihood change points around the alarm and around recovery, not the alarm times. *Onset* is when the problem started; *detected* is when the evidence became strong enough.
   - An alarm within 30 observations of a close **reopens** the episode.
   - A clear interior gap **splits** an episode retrospectively.
   - A band whose normal rate is above 25% emits `baseline.high`. That is a standing problem, not an episode.
5. **Attachment.** Every episode records the model, checkpoint and quantization in effect at onset. It also records how the host signals pushed by the orchestrator differed inside the episode from just before it (KV pressure, thermal derate, GPU temperature, queue depth, any `extra.*`, prompt size), ranked by effect size. These are co-occurring conditions, not proven causes.
6. **Training separation.** Probe families (template × kind × asked field) are split into pools with `@grahmos/trainloop`.
   - **Train**-pool hallucinations become preference pairs (`sentinel pairs`) and never feed detection, so training can't quietly fix the monitor's own probes.
   - **Retired** (leaked) families are logged and used for nothing.

## Measured accuracy (simulated model, `sentinel bench --seeds 10`)

The scenario has 2,000 probes; one probe = 30 s of simulated time. It contains two true windows:
- a thermal-throttle + q4-fallback window at probes 600–900 that affects all bands;
- a KV-pressure window at probes 1300–1600 that affects 32k only.

Errors are in probes; detection is out of 10 seeds.

| Stream, true window | Detected | Onset error (median) | Alarm delay (median) | End error (median) |
|---|---|---|---|---|
| `all`, 600–900 | 10/10 | +4 | +58 | −2 |
| `all`, 1300–1600 (32k only, diluted) | 10/10 | +37 | +90 | −16 |
| `32k`, 1300–1600 | 10/10 | +33 | +90 | +20 |
| `16k`, 600–900 | 9/10 | +58 | +104 | +37 |
| `32k`, 600–900 | 7/10 | +113 | +117 | −37 |
| `1k` / `4k`, 600–900 | 5/10 each | +216 / +139 | +227 / +229 | −28 / −17 |

Overall: 56/70 windows detected, 13 extra fragments, and 4 false alarms across 10 × 2,000 probes.

**Limits**
- **Per-band streams on the first event.** Each band sees about a fifth of all probes, so a single-band stream has only just finished its warmup when the event starts at probe 600. That is why these streams miss or start late on that event. The `|all` stream covers this period. On real hardware this means roughly the first 3–4 hours of probing, at one probe every 30 s.
- **Band-specific problems on `|all`.** These are diluted there. Use the band stream's dates for those.
- **The numbers come from a simulated model.** They measure the detector, not any real model.

## Integration with AGSI Core

| Direction | Call | Purpose |
|---|---|---|
| orchestrator → Sentinel | `POST /context {modelId, checkpoint, quantization, kvPressure, thermalDerate, gpuTempC, queueDepth, busy, extra}` | Host telemetry. Sentinel only probes while `busy` is false. |
| orchestrator → Sentinel | `POST /observe {answer, sources[], id?}` | Grounding check on a live answer. Returns `{id, hallucinated, unsupported}`. |
| Sentinel → orchestrator | `--webhook URL` posts `episode.opened` / `episode.closed` / `baseline.high` / `contamination` | Republish on NATS. |
| console → Sentinel | `GET /status`, `/episodes`, `/series?stream=&window=`, `/report` | Charts and the HTML report. |

The API binds to 127.0.0.1 and has the following protections:
- the `Host` header must be loopback (blocks DNS rebinding);
- POST bodies must be `application/json` and are capped at 2 MB;
- an optional `SENTINEL_TOKEN` bearer token, checked in constant time;
- streams capped at 64; a new model past the cap is refused at `/context`.

## Data and evidence

`data/sentinel/` holds:
- `probes.jsonl`, every probe and answer;
- `episodes.jsonl`, every transition;
- `events.jsonl`;
- `audit.jsonl`, an HMAC chain when `SENTINEL_AUDIT_KEY` is set.

On restart the audit chain is verified while it streams. Torn last lines from a crash are cut off. Probe lines are replayed only if their answer hash matches the audit entry, so editing `probes.jsonl` cannot rewrite history. `sentinel vault` writes a one-way Markdown/Obsidian export; the JSONL files stay the source of truth.

## Real-model notes

- Use `--no-thinking` for reasoning models served by vLLM (it sends `chat_template_kwargs.enable_thinking=false`). Leftover `<think>` blocks are stripped anyway.
- Bands are skipped when 1.1 × band + `--max-tokens` would exceed `--max-context`.
- Probes run at temperature 0, so changes in rate reflect the model and host, not sampling.
