// Challenge set shapes + validation. Shared by the Worker (admin API) and scripts/load-set.ts.

export const SET_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** One round as authored in a local `set.json` (image paths relative to the set folder). */
export interface SetJsonRound {
  before: string;
  target: string;
  originalPrompt: string;
  modelId: string;
  modelParams?: Record<string, unknown>;
  clue: string;
  tip: string;
}

/** The authored `set.json` file. */
export interface SetJson {
  id: string;
  title: string;
  description?: string;
  difficulty?: Difficulty;
  tags?: string[];
  author?: string;
  status?: "active" | "hidden";
  rounds: SetJsonRound[];
}

export interface ImageRef {
  key: string;
  url: string;
  width?: number;
  height?: number;
}

export interface ManifestRound {
  index: number;
  before: ImageRef;
  target: ImageRef;
  originalPrompt: string;
  modelId: string;
  modelParams: Record<string, unknown>;
  clue: string;
  tip: string;
}

/** R2 sets/{id}/manifest.json. URLs are '/assets/<key>' in storage and absolute in API responses. */
export interface ChallengeManifest {
  schemaVersion: 1;
  id: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  tags: string[];
  author: string;
  roundCount: number;
  createdAt: number;
  updatedAt: number;
  rounds: ManifestRound[];
}

/** Body of PUT /admin/sets/:id (sent by the loader after the images are uploaded). */
export interface SetUpsert {
  id: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  tags: string[];
  author: string;
  status: "active" | "hidden";
  contentHash: string;
  rounds: Array<Omit<ManifestRound, "before" | "target"> & { before: Omit<ImageRef, "url">; target: Omit<ImageRef, "url"> }>;
}

export function setKeys(setId: string, roundIndex: number) {
  return {
    before: `sets/${setId}/r${roundIndex}/before.png`,
    target: `sets/${setId}/r${roundIndex}/target.png`,
  };
}

export function manifestKey(setId: string): string {
  return `sets/${setId}/manifest.json`;
}

type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function str(v: unknown, path: string, errors: string[], opts: { min?: number; max?: number; optional?: boolean } = {}): string | undefined {
  if (v === undefined || v === null) {
    if (!opts.optional) errors.push(`${path} is required`);
    return undefined;
  }
  if (typeof v !== "string") {
    errors.push(`${path} must be a string`);
    return undefined;
  }
  const s = v.trim();
  if (opts.min !== undefined && s.length < opts.min) errors.push(`${path} must be at least ${opts.min} chars`);
  if (opts.max !== undefined && s.length > opts.max) errors.push(`${path} must be at most ${opts.max} chars`);
  return s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateSetJson(input: unknown): Result<SetJson> {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["set.json must be an object"] };
  const id = str(input.id, "id", errors);
  if (id && !SET_ID_RE.test(id)) errors.push("id must match ^[a-z0-9][a-z0-9-]{0,62}$");
  const title = str(input.title, "title", errors, { min: 1, max: 120 });
  const description = str(input.description, "description", errors, { optional: true, max: 2000 });
  const author = str(input.author, "author", errors, { optional: true, max: 120 });
  let difficulty: Difficulty | undefined;
  if (input.difficulty !== undefined) {
    if (!DIFFICULTIES.includes(input.difficulty as Difficulty)) errors.push(`difficulty must be one of ${DIFFICULTIES.join(", ")}`);
    else difficulty = input.difficulty as Difficulty;
  }
  let status: "active" | "hidden" | undefined;
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "hidden") errors.push("status must be active or hidden");
    else status = input.status;
  }
  let tags: string[] | undefined;
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.some((t) => typeof t !== "string")) errors.push("tags must be an array of strings");
    else tags = (input.tags as string[]).map((t) => t.trim()).filter(Boolean);
  }
  const rounds: SetJsonRound[] = [];
  if (!Array.isArray(input.rounds) || input.rounds.length === 0) {
    errors.push("rounds must be a non-empty array");
  } else {
    input.rounds.forEach((r, i) => {
      const p = `rounds[${i}]`;
      if (!isPlainObject(r)) {
        errors.push(`${p} must be an object`);
        return;
      }
      const round: SetJsonRound = {
        before: str(r.before, `${p}.before`, errors) ?? "",
        target: str(r.target, `${p}.target`, errors) ?? "",
        originalPrompt: str(r.originalPrompt, `${p}.originalPrompt`, errors, { min: 1, max: 2000 }) ?? "",
        modelId: str(r.modelId, `${p}.modelId`, errors, { min: 1, max: 200 }) ?? "",
        clue: str(r.clue, `${p}.clue`, errors, { min: 1, max: 500 }) ?? "",
        tip: str(r.tip, `${p}.tip`, errors, { min: 1, max: 500 }) ?? "",
      };
      if (r.modelParams !== undefined) {
        if (!isPlainObject(r.modelParams)) errors.push(`${p}.modelParams must be an object`);
        else round.modelParams = r.modelParams;
      }
      rounds.push(round);
    });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { id: id!, title: title!, description, difficulty, tags, author, status, rounds },
  };
}

export function validateSetUpsert(input: unknown, idFromPath: string): Result<SetUpsert> {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["body must be an object"] };
  if (input.id !== idFromPath) errors.push("body.id must equal the :setId in the path");
  if (!SET_ID_RE.test(idFromPath)) errors.push("invalid set id");
  const title = str(input.title, "title", errors, { min: 1, max: 120 });
  if (!Array.isArray(input.rounds) || input.rounds.length === 0) errors.push("rounds must be a non-empty array");
  const rounds = Array.isArray(input.rounds) ? input.rounds : [];
  rounds.forEach((r: unknown, i: number) => {
    const p = `rounds[${i}]`;
    if (!isPlainObject(r)) return errors.push(`${p} must be an object`);
    if (r.index !== i + 1) errors.push(`${p}.index must be ${i + 1}`);
    const keys = setKeys(idFromPath, i + 1);
    if (!isPlainObject(r.before) || r.before.key !== keys.before) errors.push(`${p}.before.key must be ${keys.before}`);
    if (!isPlainObject(r.target) || r.target.key !== keys.target) errors.push(`${p}.target.key must be ${keys.target}`);
    for (const f of ["originalPrompt", "modelId", "clue", "tip"]) str(r[f], `${p}.${f}`, errors, { min: 1 });
    if (!isPlainObject(r.modelParams)) errors.push(`${p}.modelParams must be an object`);
  });
  if (errors.length) return { ok: false, errors };
  const b = input as unknown as SetUpsert;
  return {
    ok: true,
    value: {
      id: idFromPath,
      title: title!,
      description: typeof b.description === "string" ? b.description : "",
      difficulty: DIFFICULTIES.includes(b.difficulty) ? b.difficulty : "medium",
      tags: Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === "string") : [],
      author: typeof b.author === "string" ? b.author : "",
      status: b.status === "hidden" ? "hidden" : "active",
      contentHash: typeof b.contentHash === "string" ? b.contentHash : "",
      rounds: b.rounds,
    },
  };
}
