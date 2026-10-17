import type { Slot } from "../../protocol";
import type { TeacherConfig } from "./teacher";

/** Everything a judge sees for one round. Results are null for a player who forfeited. */
export interface JudgeInput {
  teacher: TeacherConfig;
  target: Uint8Array;
  before?: Uint8Array;
  resultA: Uint8Array | null;
  resultB: Uint8Array | null;
  prompts: Record<Slot, string | null>;
  clue: string;
  originalPrompt: string;
}

/** What a judge must return (strict JSON). Only slots with a result are required. */
export interface JudgeOutput {
  players: Partial<Record<Slot, { parts: Record<string, number>; quote: string }>>;
  lesson: string;
}

export interface JudgeProvider {
  readonly id: string;
  /** Returns the parsed JSON (validated by the pipeline), or throws. */
  judge(input: JudgeInput): Promise<unknown>;
}

/** JSON Schema for the judge output, built from the teacher's rubric and the players present. */
export function judgeOutputSchema(teacher: TeacherConfig, slots: Slot[]): Record<string, unknown> {
  const partProps: Record<string, unknown> = {};
  for (const p of teacher.rubric) partProps[p.key] = { type: "integer", description: `0-${p.max}: ${p.label}` };
  const playerSchema = {
    type: "object",
    additionalProperties: false,
    required: ["parts", "quote"],
    properties: {
      parts: { type: "object", additionalProperties: false, required: teacher.rubric.map((p) => p.key), properties: partProps },
      quote: { type: "string" },
    },
  };
  const players: Record<string, unknown> = {};
  for (const s of slots) players[s] = playerSchema;
  return {
    type: "object",
    additionalProperties: false,
    required: ["players", "lesson"],
    properties: {
      players: { type: "object", additionalProperties: false, required: slots, properties: players },
      lesson: { type: "string" },
    },
  };
}

/** The user-turn instructions shared by every LLM judge provider. Images are attached separately. */
export function judgeInstructions(input: JudgeInput, slots: Slot[]): string {
  const t = input.teacher;
  const rubric = t.rubric.map((p) => `- ${p.key} (0-${p.max}, ${p.label}): ${p.description}`).join("\n");
  const students = slots.map((s) => `Student ${s} spell: ${JSON.stringify(input.prompts[s] ?? "")}`).join("\n");
  const skipped = (["A", "B"] as Slot[]).filter((s) => !slots.includes(s));
  const example: JudgeOutput = { players: {}, lesson: "..." };
  for (const s of slots) example.players[s] = { parts: Object.fromEntries(t.rubric.map((p) => [p.key, 0])), quote: "..." };
  return [
    `Round to judge. Images attached in this order: BEFORE, TARGET, ${slots.map((s) => `RESULT ${s}`).join(", ")}.`,
    `Clue shown to students: ${JSON.stringify(input.clue)}`,
    `ORIGINAL prompt that produced the TARGET: ${JSON.stringify(input.originalPrompt)}`,
    students,
    skipped.length ? `Student(s) ${skipped.join(", ")} forfeited; do not score them.` : "",
    `Rubric (integers only, each part from 0 to its max):\n${rubric}`,
    `Quote style: ${t.quoteStyle}`,
    `Reply with ONLY a JSON object, no prose, no code fences, exactly this shape:\n${JSON.stringify(example)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Extracts a JSON object from model text (tolerates code fences and leading prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("judge returned no JSON object");
  }
}
