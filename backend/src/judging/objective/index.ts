// Objective quality agent: deterministic, no model calls. Scores a result against the target out of 50.
import defaultRubric from "../../../config/objective-rubric.json";
import { decodeImage, type RgbaImage } from "../../lib/image";
import type { AgentScore } from "../../protocol";
import { keywordOverlap } from "./keywords";
import { dHashSimilarity, histogramSimilarity, ssim } from "./metrics";

export type Metric = "dhash" | "histogram" | "ssim" | "keywords";

export interface ObjectivePart {
  key: string;
  label: string;
  metric: Metric;
  max: number;
  floor: number;
  ceiling: number;
}

export interface ObjectiveRubric {
  total: number;
  imageSize: number;
  parts: ObjectivePart[];
  keywords: { minLength: number; stopwords: string[] };
}

const METRICS: readonly Metric[] = ["dhash", "histogram", "ssim", "keywords"];

export function validateObjectiveRubric(r: unknown): string[] {
  const errors: string[] = [];
  const rub = r as Partial<ObjectiveRubric>;
  if (!rub || !Array.isArray(rub.parts) || rub.parts.length === 0) return ["parts must be a non-empty array"];
  const keys = new Set<string>();
  let sum = 0;
  for (const p of rub.parts) {
    if (!p.key || keys.has(p.key)) errors.push(`duplicate or empty key: ${p.key}`);
    keys.add(p.key);
    if (!METRICS.includes(p.metric)) errors.push(`${p.key}: unknown metric ${p.metric}`);
    if (!(p.max > 0)) errors.push(`${p.key}: max must be > 0`);
    if (!(p.ceiling > p.floor)) errors.push(`${p.key}: ceiling must be > floor`);
    sum += p.max;
  }
  if (Math.abs(sum - 50) > 1e-9) errors.push(`parts must sum to 50 (got ${sum})`);
  if (rub.total !== 50) errors.push("total must be 50");
  return errors;
}

export const objectiveRubric = defaultRubric as ObjectiveRubric;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function scale(similarity: number, part: Pick<ObjectivePart, "max" | "floor" | "ceiling">): number {
  const t = (similarity - part.floor) / (part.ceiling - part.floor);
  return part.max * Math.max(0, Math.min(1, t));
}

export interface ObjectiveInput {
  target: RgbaImage | Uint8Array;
  result: RgbaImage | Uint8Array;
  prompt: string;
  originalPrompt: string;
}

export interface ObjectiveScore extends AgentScore {
  raw: Record<string, number>; // unscaled similarities, for tuning/logs
}

/** Scores one player's result. `parts` keys come from the rubric; total ≤ 50. */
export function scoreObjective(input: ObjectiveInput, rubric: ObjectiveRubric = objectiveRubric): ObjectiveScore {
  const target = input.target instanceof Uint8Array ? decodeImage(input.target) : input.target;
  const result = input.result instanceof Uint8Array ? decodeImage(input.result) : input.result;
  const stop = new Set(rubric.keywords.stopwords.map((s) => s.toLowerCase()));
  const cache = new Map<Metric, number>();
  const sim = (m: Metric): number => {
    if (!cache.has(m)) {
      const v =
        m === "dhash" ? dHashSimilarity(target, result)
        : m === "histogram" ? histogramSimilarity(target, result)
        : m === "ssim" ? ssim(target, result, rubric.imageSize)
        : keywordOverlap(input.prompt, input.originalPrompt, stop, rubric.keywords.minLength);
      cache.set(m, v);
    }
    return cache.get(m)!;
  };
  const parts: AgentScore["parts"] = {};
  const raw: Record<string, number> = {};
  let total = 0;
  for (const p of rubric.parts) {
    const s = sim(p.metric);
    raw[p.key] = Math.round(s * 1000) / 1000;
    const pts = round1(scale(s, p));
    parts[p.key] = { score: pts, max: p.max, label: p.label };
    total += pts;
  }
  return { total: round1(Math.min(50, total)), parts, raw };
}

/** All-zero objective score (e.g. the result image could not be decoded). */
export function zeroObjective(rubric: ObjectiveRubric = objectiveRubric): AgentScore {
  const parts: AgentScore["parts"] = {};
  for (const p of rubric.parts) parts[p.key] = { score: 0, max: p.max, label: p.label };
  return { total: 0, parts };
}
