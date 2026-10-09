# Grahmos AGI: evaluation, monitoring and training loop

This repo contains three packages. They are built to drop into AGSI Core (the orchestrator, NATS bus and console) as services.

| Package | What it does |
|---|---|
| [`packages/gate`](packages/gate) | **GATE**: an agent evaluation harness. It measures METR-style time horizons, treats cheating as failure (integrity detectors), and issues PASS / INSUFFICIENT / FAIL gates with exact confidence bounds. Evidence goes into a hash-chained audit log. |
| [`packages/trainloop`](packages/trainloop) | Splits task families into train / dev / holdout / canary pools, with a sealed holdout and canary strings. Exports SFT data and preference pairs only from clean train-pool runs, and serves RL environments whose reward matches GATE's scoring. |
| [`services/sentinel`](services/sentinel) | **Sentinel**: continuous hallucination monitoring. It detects when hallucination episodes begin and end, per model and context band, and attaches each one to the model, checkpoint, quantization and host conditions involved. |

```bash
pnpm install
pnpm typecheck && pnpm test   # 728 gate + 83 trainloop + 212 sentinel tests
pnpm sentinel:demo            # simulated episodes, detection vs ground truth
```

Requires Node 22 and pnpm 10.

## How it fits together

```
AGSI Core orchestrator ──POST /context, /observe──▶ Sentinel ──webhook──▶ orchestrator ──▶ NATS
         │                                             │
         │                                             ├─ probes.jsonl / episodes.jsonl / audit.jsonl (source of truth)
         │                                             └─ train-pool hallucinations ─▶ trainloop preference pairs
         ▼
GATE runs (dev pool daily, holdout at release) ─▶ trainloop exportSFT (train pool only) ─▶ SFT / RL (GateEnv)
```

Rules the code enforces:
1. Nothing outside the train pool ever reaches training data.
2. Detection and gating never use train-pool material.
3. A canary in any output means a leak, and the family is retired.
4. Every result is in a verifiable audit chain.

An Obsidian vault is available as a one-way Markdown export (`sentinel vault`). It is a view of the data, not where the data lives.
