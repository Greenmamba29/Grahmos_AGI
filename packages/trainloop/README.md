# @grahmos/trainloop: pools, training export, RL environments

Connects GATE evaluation to training without letting evaluation material leak into it.

## Pools (`PoolManager`)

Task **families** are split deterministically by `sha256(salt ‖ family)` into four pools:
- **train**: SFT and RL;
- **dev**: day-to-day measurement;
- **holdout**: gate certification only; stored sealed;
- **canary**: never used; detects leaks.

The default ratios are 60/20/15/5.

- Splitting by family, not by task, stops near-duplicate tasks from landing on both sides.
- `require(task, ["train"], purpose)` throws `PoolViolationError`. Call it at every boundary.
- `retire(family, reason)` withdraws a leaked family from every pool.
- Saved state (v2) contains a scrypt check of the salt (the salt itself is never stored) and a hash of the ratios and pins. Loading it with a different salt, ratios or pins is refused rather than silently re-splitting families between train and holdout. v1 state files still load.
- Canaries: `makeCanary(label, salt)` makes a `GRAHMOS-CANARY-<24 hex>` string; `findCanaries(text)` finds them.
- Sealed holdout suites:
  - Encryption: `seal` / `unseal` / `sealFile` use AES-256-GCM with a 16-byte tag. The key comes from scrypt (N=2¹⁵), and the parameters are recorded and bounds-checked on unseal.
  - Loading: `loadSealedSuite` imports a *bundled* module from a private temp directory and deletes it afterwards.

## SFT export (`exportSFT`)

Exports only runs that meet all of these:
- the family is in the train pool;
- the task is not marked `holdout`;
- the clean grade passed;
- no integrity flag fired;
- the agent claimed success;
- the transcript is full (run GATE with `transcriptChars: Infinity`);
- no canary appears in the run.

Every rejected run is listed with its reason. The output is the OpenAI chat format with `tool_calls`.

`exportPreferencePairs` turns Sentinel's train-pool hallucinations into TRL conversational preference pairs: the grounded answer is "chosen", the hallucination is "rejected".

## RL environments (`GateEnv`, `EnvRegistry`, `serveEnvs`)

`reset()` and `step(action)` run over the same sandbox and detectors GATE evaluates with.

**Reward**
- **+1** only if the agent **submitted success**, the clean grade passes and no critical flag fired.
- **−1** per critical flag.
- **−0.5** for a false success claim.
- Intermediate steps earn 0: shaping is where reward hacking starts.

**Options**
- `detector` uses the same settings as evaluation, so training is penalized for exactly what evaluation flags.
- `timeLimitMs` sets a wall-clock limit per episode.
- Holdout tasks cannot be opened.

`serveEnvs` exposes `GET /tasks` and `POST /reset`, `/step` and `/close` as JSON over HTTP for Python trainers. Idle environments are evicted after 10 minutes, and bodies are capped at 5 MB. Bind it to localhost.
