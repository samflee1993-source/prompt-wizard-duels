// "Magic teacher" config: any LLM judge persona. The pipeline doesn't care which one is loaded.

export interface RubricPart {
  key: string;
  label: string;
  max: number;
  description: string;
}

export interface TeacherConfig {
  id: string;
  name: string;
  systemPrompt: string;
  rubric: RubricPart[];
  quoteStyle: string;
  cannedQuotes?: {
    fallback?: string[];
    forfeit?: string[];
    void?: string[];
    lessonFallback?: string;
  };
}

export const TEACHER_TOTAL = 50;

/** Strips documentation keys ("//..." or "_...") so template files with comments still validate. */
export function stripComments<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripComments) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (!k.startsWith("//") && !k.startsWith("_")) out[k] = stripComments(val);
    return out as T;
  }
  return v;
}

export function validateTeacher(input: unknown): { ok: true; teacher: TeacherConfig } | { ok: false; errors: string[] } {
  const t = stripComments(input) as Partial<TeacherConfig>;
  const errors: string[] = [];
  if (!t || typeof t !== "object") return { ok: false, errors: ["teacher must be an object"] };
  if (typeof t.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) errors.push("id must be a lowercase slug");
  if (typeof t.name !== "string" || !t.name.trim()) errors.push("name is required");
  if (typeof t.systemPrompt !== "string" || t.systemPrompt.trim().length < 20) errors.push("systemPrompt is required (20+ chars)");
  if (typeof t.quoteStyle !== "string" || !t.quoteStyle.trim()) errors.push("quoteStyle is required");
  if (!Array.isArray(t.rubric) || t.rubric.length < 1 || t.rubric.length > 8) {
    errors.push("rubric must have 1-8 parts");
  } else {
    const keys = new Set<string>();
    let sum = 0;
    for (const [i, p] of t.rubric.entries()) {
      if (typeof p.key !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(p.key)) errors.push(`rubric[${i}].key must be lowercase snake_case`);
      else if (keys.has(p.key)) errors.push(`rubric[${i}].key '${p.key}' is duplicated`);
      keys.add(p.key);
      if (typeof p.label !== "string" || !p.label.trim()) errors.push(`rubric[${i}].label is required`);
      if (typeof p.description !== "string" || !p.description.trim()) errors.push(`rubric[${i}].description is required`);
      if (!Number.isInteger(p.max) || p.max <= 0) errors.push(`rubric[${i}].max must be a positive integer`);
      sum += Number(p.max) || 0;
    }
    if (sum !== TEACHER_TOTAL) errors.push(`rubric maxes must sum to ${TEACHER_TOTAL} (got ${sum})`);
  }
  if (t.cannedQuotes !== undefined) {
    const c = t.cannedQuotes;
    for (const k of ["fallback", "forfeit", "void"] as const) {
      if (c[k] !== undefined && (!Array.isArray(c[k]) || c[k]!.some((q) => typeof q !== "string"))) errors.push(`cannedQuotes.${k} must be an array of strings`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, teacher: t as TeacherConfig };
}

const GENERIC = {
  fallback: ["The judge is having a moment. Half marks for everyone while it reboots."],
  forfeit: ["No spell was cast, so the model had nothing to work with."],
  void: ["The image model failed twice. This round doesn't count."],
  lessonFallback: "Say exactly what changes, and say what must stay the same.",
};

/** Deterministic pick so retries and replays show the same canned line. */
export function cannedQuote(t: TeacherConfig, kind: "fallback" | "forfeit" | "void", seed: string): string {
  const list = t.cannedQuotes?.[kind]?.length ? t.cannedQuotes[kind]! : GENERIC[kind];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

export function lessonFallback(t: TeacherConfig): string {
  return t.cannedQuotes?.lessonFallback ?? GENERIC.lessonFallback;
}
