// API Worker: access code → session, per-device rate limit, routing to the Matchmaker and Match DOs.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { DEVICE_ID_RE, bearer, cleanDisplayName, secretEquals, signSession, verifySession, type Session } from "./auth";
import { absolutizeManifest, getManifest, HttpError, listSets, upsertSet } from "./challenges/repo";
import { validateSetUpsert } from "./challenges/schema";
import { log, readConfig } from "./config";
import { loadTeacher } from "./judging/whiskers/teachers";

export { MatchDO } from "./match/MatchDO";
export { MatchmakerDO } from "./matchmaker/MatchmakerDO";

const VERSION = "1.0.0";
const MATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASSET_KEY_RE = /^(sets|matches)\/[A-Za-z0-9._/-]+$/;

type AppEnv = { Bindings: Env; Variables: { session: Session } };
const app = new Hono<AppEnv>();

const fail = (status: number, code: string, message: string) => new HttpError(status, code, message);

function assetBase(c: Context<AppEnv>): string {
  const cfg = readConfig(c.env);
  return cfg.assetBaseUrl || `${new URL(c.req.url).origin}/assets`;
}

async function jsonBody<T>(c: Context<AppEnv>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw fail(400, "bad_request", "Body must be JSON.");
  }
}

async function rateLimit(env: Env, key: string): Promise<void> {
  const { success } = await env.RATE_LIMITER.limit({ key });
  if (!success) throw fail(429, "rate_limited", "Slow down, wizard.");
}

const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c.req.header("authorization")) ?? c.req.query("token") ?? null;
  const session = await verifySession(c.env, token);
  if (!session) throw fail(401, "invalid_token", "Missing, invalid or expired session token.");
  await rateLimit(c.env, `device:${session.deviceId}`);
  c.set("session", session);
  await next();
};

const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const configured = c.env.ADMIN_TOKEN;
  if (!configured) throw fail(404, "not_found", "Not found.");
  const token = bearer(c.req.header("authorization"));
  if (!token || !(await secretEquals(token, configured))) throw fail(401, "invalid_token", "Bad admin token.");
  await next();
};

app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PUT", "HEAD", "OPTIONS"], maxAge: 86400 }));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  log("error", "unhandled error", { path: new URL(c.req.url).pathname, error: err instanceof Error ? err.stack ?? err.message : String(err) });
  return c.json({ error: { code: "internal", message: "Something went wrong in the spell lab." } }, 500);
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));

// --- public ------------------------------------------------------------------

app.get("/health", (c) => {
  const cfg = readConfig(c.env);
  return c.json({
    ok: true,
    service: "prompt-wizard-duels",
    version: VERSION,
    time: Date.now(),
    providers: { imageGen: cfg.imageGenProvider, judge: cfg.judgeProvider, teacher: loadTeacher(cfg.teacher).id },
    config: {
      roundsPerMatch: cfg.roundsPerMatch,
      castSeconds: cfg.castSeconds,
      queueTimeoutSeconds: cfg.queueTimeoutSeconds,
      disconnectGraceSeconds: cfg.disconnectGraceSeconds,
    },
  });
});

app.post("/session", async (c) => {
  const body = await jsonBody<{ accessCode?: unknown; deviceId?: unknown; displayName?: unknown }>(c);
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  if (!DEVICE_ID_RE.test(deviceId)) throw fail(400, "bad_request", "deviceId must be 8-64 chars of [A-Za-z0-9_-].");
  await rateLimit(c.env, `session:${deviceId}`);
  if (!c.env.ACCESS_CODE) throw fail(500, "internal", "ACCESS_CODE is not configured.");
  if (typeof body.accessCode !== "string" || !(await secretEquals(body.accessCode.trim(), c.env.ACCESS_CODE))) {
    throw fail(401, "bad_access_code", "That is not the secret word.");
  }
  const cfg = readConfig(c.env);
  const displayName = cleanDisplayName(body.displayName, deviceId);
  const exp = Date.now() + cfg.sessionTtlHours * 3600 * 1000;
  const token = await signSession(c.env, { deviceId, displayName, exp });
  const now = Date.now();
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO players (device_id, display_name, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (device_id) DO UPDATE SET display_name = excluded.display_name, last_seen_at = excluded.last_seen_at`,
    )
      .bind(deviceId, displayName, now)
      .run()
      .catch((e) => log("error", "player upsert failed", { error: String(e) })),
  );
  return c.json({ token, deviceId, displayName, expiresAt: exp });
});

app.on(["GET", "HEAD"], "/assets/*", async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.slice("/assets/".length));
  if (!ASSET_KEY_RE.test(key) || key.includes("..")) throw fail(404, "not_found", "Not found.");
  const obj = c.req.method === "HEAD" ? await c.env.BUCKET.head(key) : await c.env.BUCKET.get(key);
  if (!obj) throw fail(404, "not_found", "Not found.");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  // Set images are immutable per key (reloads keep the same bytes or a new hash); match results never change.
  headers.set("cache-control", key.endsWith("manifest.json") ? "public, max-age=60" : "public, max-age=86400");
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  return new Response(c.req.method === "HEAD" ? null : (obj as R2ObjectBody).body, { headers });
});

// --- authed ------------------------------------------------------------------

app.post("/queue/join", requireSession, async (c) => {
  const s = c.get("session");
  const mm = c.env.MATCHMAKER.getByName("global");
  const res = await mm.join(s.deviceId, s.displayName, assetBase(c));
  if ("error" in res) {
    if (res.error === "daily_cap_reached") throw fail(429, "daily_cap_reached", "The duel hall is closed for today. Come back tomorrow.");
    throw fail(503, "no_challenge_sets", "No challenge sets are loaded yet.");
  }
  return c.json(withWsUrl(c, res));
});

app.get("/queue/status", requireSession, async (c) => {
  const s = c.get("session");
  return c.json(withWsUrl(c, await c.env.MATCHMAKER.getByName("global").status(s.deviceId)));
});

app.post("/queue/leave", requireSession, async (c) => {
  const s = c.get("session");
  return c.json(await c.env.MATCHMAKER.getByName("global").leave(s.deviceId));
});

app.get("/match/:id/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw fail(426, "bad_request", "Expected a WebSocket upgrade.");
  const id = c.req.param("id");
  if (!MATCH_ID_RE.test(id)) throw fail(404, "not_found", "Unknown match.");
  const session = await verifySession(c.env, c.req.query("token") ?? bearer(c.req.header("authorization")));
  if (!session) throw fail(401, "invalid_token", "Missing, invalid or expired session token.");
  await rateLimit(c.env, `device:${session.deviceId}`);
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-device-id", session.deviceId); // overwrite anything the client sent
  const res = await c.env.MATCH.getByName(id).fetch(new Request(c.req.url, { headers }));
  if (res.status === 403) throw fail(403, "not_participant", "You are not in this duel.");
  if (res.status === 404) throw fail(404, "not_found", "Unknown match.");
  return res;
});

app.get("/match/:id", requireSession, async (c) => {
  const id = c.req.param("id");
  if (!MATCH_ID_RE.test(id)) throw fail(404, "not_found", "Unknown match.");
  const snap = await c.env.MATCH.getByName(id).snapshot(c.get("session").deviceId);
  if (snap === null) throw fail(404, "not_found", "Unknown match.");
  if (snap === "forbidden") throw fail(403, "not_participant", "You are not in this duel.");
  return c.json(snap);
});

app.get("/challenges", requireSession, async (c) => {
  const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 20) || 20));
  try {
    return c.json(await listSets(c.env.DB, assetBase(c), limit, c.req.query("cursor")));
  } catch (e) {
    if (e instanceof Error && e.message === "bad cursor") throw fail(400, "bad_request", "Bad cursor.");
    throw e;
  }
});

app.get("/challenges/:setId", requireSession, async (c) => {
  const m = await getManifest(c.env.BUCKET, c.req.param("setId"));
  if (!m) throw fail(404, "not_found", "Unknown challenge set.");
  return c.json(absolutizeManifest(m, assetBase(c)));
});

// --- admin (scripts/load-set.ts) ----------------------------------------------

// Hono routes HEAD through GET handlers, so GET/HEAD both return the metadata check.
app.on(["GET", "HEAD", "PUT"], "/admin/assets/*", requireAdmin, async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.slice("/admin/assets/".length));
  if (!/^sets\/[a-z0-9][a-z0-9-]{0,62}\/[A-Za-z0-9._/-]+$/.test(key) || key.includes("..")) throw fail(400, "bad_request", "Asset keys must live under sets/<id>/.");
  if (c.req.method !== "PUT") {
    const h = await c.env.BUCKET.head(key);
    if (!h) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: { "x-content-sha256": h.customMetadata?.sha256 ?? "" } });
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > 10 * 1024 * 1024) throw fail(400, "bad_request", "Image must be 1 byte to 10 MB.");
  const sha = c.req.header("x-content-sha256") ?? "";
  await c.env.BUCKET.put(key, body, {
    httpMetadata: { contentType: c.req.header("content-type") ?? "image/png" },
    customMetadata: sha ? { sha256: sha } : undefined,
  });
  return c.json({ ok: true, key, bytes: body.byteLength });
});

app.put("/admin/sets/:setId", requireAdmin, async (c) => {
  const v = validateSetUpsert(await jsonBody<unknown>(c), c.req.param("setId"));
  if (!v.ok) throw fail(400, "bad_request", v.errors.join("; "));
  const { changed, manifest } = await upsertSet(c.env, v.value);
  return c.json({ ok: true, changed, manifestKey: `sets/${v.value.id}/manifest.json`, manifest });
});

function withWsUrl<T extends { status: string }>(c: Context<AppEnv>, res: T): T & { wsUrl?: string } {
  if (res.status !== "matched" || !("matchId" in res)) return res;
  const u = new URL(c.req.url);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return { ...res, wsUrl: `${proto}//${u.host}/match/${(res as { matchId: string }).matchId}/ws` };
}

export default app satisfies ExportedHandler<Env>;
