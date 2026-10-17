// D1 + R2 access for the challenge library.
import { manifestKey, type ChallengeManifest, type ImageRef, type SetUpsert } from "./schema";

export interface SetListItem {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  tags: string[];
  author: string;
  roundCount: number;
  thumbnailUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SetRow {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  tags: string;
  author: string;
  round_count: number;
  thumbnail_key: string | null;
  created_at: number;
  updated_at: number;
  content_hash: string;
}

export function assetUrl(assetBase: string, key: string): string {
  return `${assetBase.replace(/\/+$/, "")}/${key}`;
}

function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const raw = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const i = raw.indexOf(":");
    const createdAt = Number(raw.slice(0, i));
    if (i < 1 || !Number.isFinite(createdAt)) return null;
    return { createdAt, id: raw.slice(i + 1) };
  } catch {
    return null;
  }
}

/** Keyset-paged listing, newest first. */
export async function listSets(db: D1Database, assetBase: string, limit: number, cursor?: string | null) {
  const c = cursor ? decodeCursor(cursor) : null;
  if (cursor && !c) throw new Error("bad cursor");
  const cols = "id, title, description, difficulty, tags, author, round_count, thumbnail_key, created_at, updated_at, content_hash";
  const stmt = c
    ? db
        .prepare(
          `SELECT ${cols} FROM challenge_sets WHERE status = 'active' AND (created_at < ?1 OR (created_at = ?1 AND id < ?2))
           ORDER BY created_at DESC, id DESC LIMIT ?3`,
        )
        .bind(c.createdAt, c.id, limit + 1)
    : db.prepare(`SELECT ${cols} FROM challenge_sets WHERE status = 'active' ORDER BY created_at DESC, id DESC LIMIT ?1`).bind(limit + 1);
  const { results } = await stmt.all<SetRow>();
  const page = results.slice(0, limit);
  const items: SetListItem[] = page.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    difficulty: r.difficulty,
    tags: safeJson<string[]>(r.tags, []),
    author: r.author,
    roundCount: r.round_count,
    thumbnailUrl: r.thumbnail_key ? assetUrl(assetBase, r.thumbnail_key) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const last = page[page.length - 1];
  return { items, nextCursor: results.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

export async function getManifest(bucket: R2Bucket, setId: string): Promise<ChallengeManifest | null> {
  const obj = await bucket.get(manifestKey(setId));
  if (!obj) return null;
  return (await obj.json()) as ChallengeManifest;
}

/** Rewrites stored '/assets/<key>' URLs to absolute ones under assetBase. */
export function absolutizeManifest(m: ChallengeManifest, assetBase: string): ChallengeManifest {
  const fix = (r: ImageRef): ImageRef => ({ ...r, url: assetUrl(assetBase, r.key) });
  return { ...m, rounds: m.rounds.map((r) => ({ ...r, before: fix(r.before), target: fix(r.target) })) };
}

export async function pickRandomSet(db: D1Database, minRounds: number): Promise<{ id: string; title: string } | null> {
  return await db
    .prepare(`SELECT id, title FROM challenge_sets WHERE status = 'active' AND round_count >= ?1 ORDER BY RANDOM() LIMIT 1`)
    .bind(minRounds)
    .first<{ id: string; title: string }>();
}

/** Idempotent upsert of a set's D1 rows and its R2 manifest. Images must already be in R2. */
export async function upsertSet(env: Env, s: SetUpsert): Promise<{ changed: boolean; manifest: ChallengeManifest }> {
  const now = Date.now();
  // Every referenced image must exist before the set becomes visible.
  const heads = await Promise.all(s.rounds.flatMap((r) => [r.before.key, r.target.key]).map((k) => env.BUCKET.head(k).then((h) => [k, h] as const)));
  const missing = heads.filter(([, h]) => !h).map(([k]) => k);
  if (missing.length) throw new HttpError(400, "bad_request", `missing images in R2: ${missing.join(", ")}`);

  const existing = await env.DB.prepare("SELECT created_at, content_hash, status FROM challenge_sets WHERE id = ?1")
    .bind(s.id)
    .first<{ created_at: number; content_hash: string; status: string }>();
  const createdAt = existing?.created_at ?? now;
  const unchanged = !!existing && existing.content_hash === s.contentHash && s.contentHash !== "" && existing.status === s.status;
  const hasManifest = unchanged ? !!(await env.BUCKET.head(manifestKey(s.id))) : false;

  const manifest: ChallengeManifest = {
    schemaVersion: 1,
    id: s.id,
    title: s.title,
    description: s.description,
    difficulty: s.difficulty,
    tags: s.tags,
    author: s.author,
    roundCount: s.rounds.length,
    createdAt,
    updatedAt: unchanged ? (await env.DB.prepare("SELECT updated_at FROM challenge_sets WHERE id = ?1").bind(s.id).first<number>("updated_at")) ?? now : now,
    rounds: s.rounds.map((r) => ({
      index: r.index,
      before: { ...r.before, url: `/assets/${r.before.key}` },
      target: { ...r.target, url: `/assets/${r.target.key}` },
      originalPrompt: r.originalPrompt,
      modelId: r.modelId,
      modelParams: r.modelParams ?? {},
      clue: r.clue,
      tip: r.tip,
    })),
  };
  if (unchanged && hasManifest) return { changed: false, manifest };

  // Manifest first: a set row never points at a missing manifest.
  await env.BUCKET.put(manifestKey(s.id), JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO challenge_sets (id, title, description, difficulty, tags, author, round_count, status, manifest_key, thumbnail_key, content_hash, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, description = excluded.description, difficulty = excluded.difficulty,
         tags = excluded.tags, author = excluded.author, round_count = excluded.round_count, status = excluded.status,
         manifest_key = excluded.manifest_key, thumbnail_key = excluded.thumbnail_key, content_hash = excluded.content_hash,
         updated_at = excluded.updated_at`,
    ).bind(
      s.id, s.title, s.description, s.difficulty, JSON.stringify(s.tags), s.author, s.rounds.length, s.status,
      manifestKey(s.id), s.rounds[0]?.target.key ?? null, s.contentHash, createdAt, manifest.updatedAt,
    ),
    env.DB.prepare("DELETE FROM challenge_rounds WHERE set_id = ?1 AND round_index > ?2").bind(s.id, s.rounds.length),
    ...s.rounds.map((r) =>
      env.DB.prepare(
        `INSERT INTO challenge_rounds (set_id, round_index, before_key, target_key, original_prompt, model_id, model_params, clue, tip)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (set_id, round_index) DO UPDATE SET before_key = excluded.before_key, target_key = excluded.target_key,
           original_prompt = excluded.original_prompt, model_id = excluded.model_id, model_params = excluded.model_params,
           clue = excluded.clue, tip = excluded.tip`,
      ).bind(s.id, r.index, r.before.key, r.target.key, r.originalPrompt, r.modelId, JSON.stringify(r.modelParams ?? {}), r.clue, r.tip),
    ),
  ];
  await env.DB.batch(stmts);
  return { changed: true, manifest };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}
