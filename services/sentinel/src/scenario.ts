import type { HostContext, Probe } from "./types.js";

/**
 * Demo / test scenario with known ground truth. Time is measured in probes.
 *
 *   0–599       normal: 2–4% hallucination depending on context length
 *   600–899     thermal throttling + fallback to a 4-bit quantization: ×6 everywhere
 *   900–1299    normal
 *   1300–1599   KV-cache pressure: 32k-context probes jump to 45%
 *   1600–1999   normal
 *
 * Sentinel should report two episode families: one starting near 600 and
 * ending near 900 on every stream, and one starting near 1300 and ending near
 * 1600 on the 32k stream only — with thermalDerate/quantization and
 * kvPressure surfaced as what changed.
 */
export interface Regime {
  name: string;
  from: number;
  to: number;
  bands?: number[];
}

export const SCENARIO: Regime[] = [
  { name: "thermal throttle + q4 fallback", from: 600, to: 900 },
  { name: "KV-cache pressure on long context", from: 1300, to: 1600, bands: [32000] },
];
export const SCENARIO_LENGTH = 2000;

export function hostAt(i: number, modelId = "qwen3.6-27b"): HostContext {
  const thermal = i >= 600 && i < 900;
  const kv = i >= 1300 && i < 1600;
  return {
    modelId,
    checkpoint: "ckpt-2026-10-01",
    quantization: thermal ? "q4_k_m" : "q8_0",
    thermalDerate: thermal ? 0.35 + ((i * 7) % 10) / 100 : 0.02 + ((i * 3) % 4) / 100,
    gpuTempC: thermal ? 88 + ((i * 5) % 6) : 64 + ((i * 3) % 7),
    kvPressure: kv ? 0.93 + ((i * 3) % 6) / 100 : 0.35 + ((i * 7) % 20) / 100,
    queueDepth: (i * 11) % 3,
    busy: false,
  };
}

export function scenarioRate(i: () => number) {
  return (p: Probe): number => {
    const t = i();
    const base = p.band >= 16000 ? 0.04 : 0.02;
    if (t >= 600 && t < 900) return Math.min(0.9, base * 6);
    if (t >= 1300 && t < 1600 && p.band >= 32000) return 0.45;
    return base;
  };
}
