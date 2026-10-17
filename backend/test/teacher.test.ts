import { describe, expect, it } from "vitest";
import { normalizeJudgeOutput, runWhiskers } from "../src/judging/whiskers";
import { StubJudgeProvider } from "../src/judging/whiskers/providers/stub";
import { stripComments, validateTeacher, type TeacherConfig } from "../src/judging/whiskers/teacher";
import { TEACHER_FILES, loadTeacher } from "../src/judging/whiskers/teachers";
import { judgeOutputSchema, type JudgeInput, type JudgeProvider } from "../src/judging/whiskers/types";

const whiskers = loadTeacher("professor-whiskers");
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function input(over: Partial<JudgeInput> = {}): JudgeInput {
  return {
    teacher: whiskers,
    target: png,
    resultA: png,
    resultB: png,
    prompts: { A: "orange sunset, keep the circle", B: "nice" },
    clue: "clue",
    originalPrompt: "background turned to a warm orange sunset, keep the yellow circle",
    ...over,
  };
}

class FakeJudge implements JudgeProvider {
  readonly id = "fake";
  calls = 0;
  constructor(private replies: unknown[]) {}
  async judge(): Promise<unknown> {
    const r = this.replies[Math.min(this.calls++, this.replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  }
}

const good = (a = 10, b = 5) => ({
  players: {
    A: { parts: { intent: a, fidelity: a, specificity: 8, craft: 8 }, quote: "A quote" },
    B: { parts: { intent: b, fidelity: b, specificity: 2, craft: 2 }, quote: "B quote" },
  },
  lesson: "Name what stays.",
});

describe("teacher configs", () => {
  it.each(Object.keys(TEACHER_FILES))("%s is valid (rubric sums to 50)", (id) => {
    const v = validateTeacher(TEACHER_FILES[id]);
    expect(v.ok ? [] : v.errors).toEqual([]);
    if (v.ok) expect(v.teacher.rubric.reduce((s, p) => s + p.max, 0)).toBe(50);
  });

  it("template comments ('//' keys) are stripped", () => {
    const t = stripComments(TEACHER_FILES["template-teacher"]) as Record<string, unknown>;
    expect(Object.keys(t).some((k) => k.startsWith("//"))).toBe(false);
  });

  it("rejects a rubric that doesn't sum to 50, duplicate keys, and missing fields", () => {
    const base = TEACHER_FILES["professor-whiskers"] as TeacherConfig;
    const bad1 = validateTeacher({ ...base, rubric: base.rubric.map((r, i) => (i ? r : { ...r, max: r.max + 1 })) });
    expect(bad1.ok).toBe(false);
    if (!bad1.ok) expect(bad1.errors.join()).toMatch(/sum to 50/);
    const bad2 = validateTeacher({ ...base, rubric: [...base.rubric.slice(0, 3), { ...base.rubric[0] }] });
    expect(bad2.ok).toBe(false);
    const bad3 = validateTeacher({ ...base, quoteStyle: "" });
    expect(bad3.ok).toBe(false);
  });

  it("unknown teacher ids fall back to Professor Whiskers", () => {
    expect(loadTeacher("nope").id).toBe("professor-whiskers");
  });

  it("judge schema requires every rubric key for each present player", () => {
    const schema = judgeOutputSchema(whiskers, ["A"]) as { properties: { players: { required: string[]; properties: Record<string, { properties: { parts: { required: string[] } } }> } } };
    expect(schema.properties.players.required).toEqual(["A"]);
    expect(schema.properties.players.properties.A.properties.parts.required).toEqual(whiskers.rubric.map((r) => r.key));
  });
});

describe("Whiskers pipeline", () => {
  it("normalises valid output and clamps out-of-range scores", () => {
    const raw = good(99, -3);
    const out = normalizeJudgeOutput(raw, whiskers, ["A", "B"])!;
    expect(out.players.A!.parts.intent).toBe(15);
    expect(out.players.B!.parts.intent).toBe(0);
  });

  it("treats a missing rubric key or empty quote as malformed", () => {
    const missing = good();
    delete (missing.players.A.parts as Record<string, number>).craft;
    expect(normalizeJudgeOutput(missing, whiskers, ["A", "B"])).toBeNull();
    const noQuote = good();
    noQuote.players.B.quote = " ";
    expect(normalizeJudgeOutput(noQuote, whiskers, ["A", "B"])).toBeNull();
  });

  it("succeeds first try with valid JSON", async () => {
    const r = await runWhiskers(new FakeJudge([good()]), input(), "seed");
    expect(r).toMatchObject({ fallback: false, attempts: 1, lesson: "Name what stays." });
    expect(r.scores.A!.total).toBe(36);
    expect(r.scores.A!.parts.intent).toEqual({ score: 10, max: 15, label: "Spell intent" });
  });

  it("retries once on malformed JSON, then succeeds", async () => {
    const judge = new FakeJudge([{ nope: true }, good()]);
    const r = await runWhiskers(judge, input(), "seed");
    expect(judge.calls).toBe(2);
    expect(r.fallback).toBe(false);
  });

  it("falls back to 25/50 with a canned quote after two bad replies", async () => {
    const judge = new FakeJudge([new Error("503"), "not json"]);
    const r = await runWhiskers(judge, input(), "seed");
    expect(judge.calls).toBe(2);
    expect(r.fallback).toBe(true);
    for (const s of ["A", "B"] as const) {
      expect(r.scores[s]!.total).toBe(25);
      expect(r.scores[s]!.fallback).toBe(true);
      expect(whiskers.cannedQuotes!.fallback).toContain(r.scores[s]!.quote);
    }
  });

  it("only judges players who have a result", async () => {
    const r = await runWhiskers(new StubJudgeProvider(), input({ resultB: null, prompts: { A: "orange sunset", B: null } }), "seed");
    expect(r.scores.A).not.toBeNull();
    expect(r.scores.B).toBeNull();
  });
});
