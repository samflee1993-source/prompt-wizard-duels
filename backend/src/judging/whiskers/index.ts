// Professor Whiskers pipeline: call the judge provider, validate strict JSON, retry once, then fall back.
import { log } from "../../config";
import type { Slot, WhiskersScore } from "../../protocol";
import { cannedQuote, lessonFallback, type TeacherConfig } from "./teacher";
import type { JudgeInput, JudgeOutput, JudgeProvider } from "./types";

export interface WhiskersResult {
  scores: Record<Slot, WhiskersScore | null>;
  lesson: string;
  fallback: boolean;
  attempts: number;
  provider: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Validates and normalises judge output. Returns null if the output is malformed. */
export function normalizeJudgeOutput(raw: unknown, teacher: TeacherConfig, slots: Slot[]): JudgeOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { players?: Record<string, { parts?: Record<string, unknown>; quote?: unknown }>; lesson?: unknown };
  if (!o.players || typeof o.players !== "object") return null;
  const out: JudgeOutput = { players: {}, lesson: "" };
  for (const s of slots) {
    const p = o.players[s];
    if (!p || typeof p !== "object" || !p.parts || typeof p.parts !== "object") return null;
    const parts: Record<string, number> = {};
    for (const r of teacher.rubric) {
      const v = Number(p.parts[r.key]);
      if (!Number.isFinite(v)) return null;
      parts[r.key] = Math.max(0, Math.min(r.max, Math.round(v)));
    }
    const quote = typeof p.quote === "string" ? p.quote.trim().replace(/\s+/g, " ").slice(0, 300) : "";
    if (!quote) return null;
    out.players[s] = { parts, quote };
  }
  out.lesson = typeof o.lesson === "string" && o.lesson.trim() ? o.lesson.trim().replace(/\s+/g, " ").slice(0, 200) : lessonFallback(teacher);
  return out;
}

function toScore(teacher: TeacherConfig, parts: Record<string, number>, quote: string, fallback = false): WhiskersScore {
  const out: WhiskersScore = { total: 0, parts: {}, quote };
  for (const r of teacher.rubric) {
    out.parts[r.key] = { score: parts[r.key], max: r.max, label: r.label };
    out.total += parts[r.key];
  }
  out.total = round1(out.total);
  if (fallback) out.fallback = true;
  return out;
}

/** Canned 25/50: every part at half its max. */
export function fallbackScore(teacher: TeacherConfig, seed: string): WhiskersScore {
  const parts = Object.fromEntries(teacher.rubric.map((r) => [r.key, r.max / 2]));
  return toScore(teacher, parts, cannedQuote(teacher, "fallback", seed), true);
}

export async function runWhiskers(provider: JudgeProvider, input: JudgeInput, seed: string): Promise<WhiskersResult> {
  const slots = (["A", "B"] as Slot[]).filter((s) => (s === "A" ? input.resultA : input.resultB) !== null);
  const scores: Record<Slot, WhiskersScore | null> = { A: null, B: null };
  if (slots.length === 0) return { scores, lesson: lessonFallback(input.teacher), fallback: false, attempts: 0, provider: provider.id };

  let attempts = 0;
  for (; attempts < 2; ) {
    attempts++;
    try {
      const raw = await provider.judge(input);
      const out = normalizeJudgeOutput(raw, input.teacher, slots);
      if (out) {
        for (const s of slots) scores[s] = toScore(input.teacher, out.players[s]!.parts, out.players[s]!.quote);
        return { scores, lesson: out.lesson, fallback: false, attempts, provider: provider.id };
      }
      log("warn", "judge returned malformed JSON", { provider: provider.id, attempt: attempts, sample: JSON.stringify(raw)?.slice(0, 300) });
    } catch (e) {
      log("warn", "judge call failed", { provider: provider.id, attempt: attempts, error: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const s of slots) scores[s] = fallbackScore(input.teacher, `${seed}:${s}`);
  return { scores, lesson: lessonFallback(input.teacher), fallback: true, attempts, provider: provider.id };
}
