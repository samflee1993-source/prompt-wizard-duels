// Every tunable, parsed from env with defaults. CONTRACT.md §7 documents the same table.

export interface AppConfig {
  roundsPerMatch: number;
  castSeconds: number;
  castGraceSeconds: number;
  queueTimeoutSeconds: number;
  disconnectGraceSeconds: number;
  readyTimeoutSeconds: number;
  verdictSeconds: number;
  maxPromptChars: number;
  dailyDuelCap: number; // 0 = unlimited
  sessionTtlHours: number;
  imageGenProvider: string;
  imageGenModel: string;
  judgeProvider: string;
  judgeModel: string;
  judgeVisionModel: string;
  teacher: string;
  aiGatewayUrl: string;
  openArtBaseUrl: string;
  assetBaseUrl: string;
}

function int(v: unknown, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function s(v: unknown, def: string): string {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : def;
}

export function readConfig(env: Partial<Record<keyof Env, unknown>>): AppConfig {
  return {
    roundsPerMatch: int(env.ROUNDS_PER_MATCH, 3, 1, 15),
    castSeconds: int(env.CAST_SECONDS, 60, 5, 600),
    castGraceSeconds: int(env.CAST_GRACE_SECONDS, 3, 0, 30),
    queueTimeoutSeconds: int(env.QUEUE_TIMEOUT_SECONDS, 60, 5, 3600),
    disconnectGraceSeconds: int(env.DISCONNECT_GRACE_SECONDS, 30, 1, 3600),
    readyTimeoutSeconds: int(env.READY_TIMEOUT_SECONDS, 15, 0, 600),
    verdictSeconds: int(env.VERDICT_SECONDS, 12, 0, 600),
    maxPromptChars: int(env.MAX_PROMPT_CHARS, 400, 20, 4000),
    dailyDuelCap: int(env.DAILY_DUEL_CAP, 200, 0),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 720, 1, 24 * 365),
    imageGenProvider: s(env.IMAGE_GEN_PROVIDER, "workers-ai"),
    imageGenModel: s(env.IMAGE_GEN_MODEL, "@cf/black-forest-labs/flux-2-klein-4b"),
    judgeProvider: s(env.JUDGE_PROVIDER, "anthropic"),
    judgeModel: s(env.JUDGE_MODEL, "claude-haiku-5-5"),
    judgeVisionModel: s(env.JUDGE_VISION_MODEL, "@cf/meta/llama-4-scout-17b-16e-instruct"),
    teacher: s(env.TEACHER, "professor-whiskers"),
    aiGatewayUrl: s(env.AI_GATEWAY_URL, ""),
    openArtBaseUrl: s(env.OPENART_BASE_URL, "https://api.openart.ai/v1"),
    assetBaseUrl: s(env.ASSET_BASE_URL, ""),
  };
}

/** Structured JSON log line (Workers Logs indexes these fields). */
export function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

const warnedOnce = new Set<string>();
/** Logs a warning at most once per isolate (e.g. "provider key missing, falling back"). */
export function warnOnce(key: string, message: string, fields: Record<string, unknown> = {}): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  log("warn", message, fields);
}
