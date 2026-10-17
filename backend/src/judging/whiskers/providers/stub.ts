// Deterministic judge for tests and keyless local play. Scores lean on prompt/original keyword overlap.
import { objectiveRubric } from "../../objective";
import { keywordOverlap } from "../../objective/keywords";
import type { Slot } from "../../../protocol";
import type { JudgeInput, JudgeOutput, JudgeProvider } from "../types";

const QUOTES = [
  "You asked for mist and received soup. That is on the model. It was deployed on a Friday.",
  "Solid spell. The GPU barely broke a sweat, which is more than I can say for my pager.",
  "The model read your prompt, nodded, and hallucinated with confidence. Peak enterprise behaviour.",
  "Nice. You said what to change AND what to keep. My change tickets never manage both.",
  "I have been awake for 41 hours and this result is the most coherent thing I've seen today.",
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

export class StubJudgeProvider implements JudgeProvider {
  readonly id = "stub";

  async judge(input: JudgeInput): Promise<unknown> {
    const stop = new Set(objectiveRubric.keywords.stopwords);
    const out: JudgeOutput = { players: {}, lesson: "The original spell named the change and what to keep, so the model didn't have to guess." };
    for (const s of ["A", "B"] as Slot[]) {
      if ((s === "A" ? input.resultA : input.resultB) === null) continue;
      const prompt = input.prompts[s] ?? "";
      const overlap = keywordOverlap(prompt, input.originalPrompt, stop);
      const h = hash(`${s}:${prompt}`);
      const parts: Record<string, number> = {};
      for (const r of input.teacher.rubric) {
        const jitter = ((h >>> (r.key.length % 16)) % 11) / 100; // 0..0.10
        parts[r.key] = Math.round(r.max * Math.min(1, 0.3 + 0.55 * overlap + jitter));
      }
      out.players[s] = { parts, quote: QUOTES[h % QUOTES.length] };
    }
    return out;
  }
}
