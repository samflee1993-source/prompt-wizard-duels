// One Durable Object per match. SQLite-backed state, WebSocket Hibernation, alarm-driven phases.
//
// Phase machine: lobby → intro → casting → generating → judging → verdict → (intro | ended).
// State is one JSON document in SQLite, rewritten after every transition, so a crash or eviction
// resumes from the last phase. Long work (generation, judging) runs inside alarm() so that a crash
// mid-step is retried by the alarm system; per-player progress is persisted as it happens.
import { DurableObject } from "cloudflare:workers";
import { absolutizeManifest, getManifest } from "../challenges/repo";
import { log, readConfig, type AppConfig } from "../config";
import { scoreObjective, zeroObjective } from "../judging/objective";
import { runWhiskers } from "../judging/whiskers";
import { createJudgeProvider } from "../judging/whiskers/providers";
import { cannedQuote, lessonFallback, type TeacherConfig } from "../judging/whiskers/teacher";
import { loadTeacher } from "../judging/whiskers/teachers";
import { decodeImage, sniffFormat, type RgbaImage } from "../lib/image";
import {
  SLOTS,
  other,
  parseClientMessage,
  type MatchEndPayload,
  type MatchEndReason,
  type MatchSnapshot,
  type Phase,
  type PlayerScore,
  type RevealPayload,
  type RoundIntroPayload,
  type ServerEvents,
  type ServerEventType,
  type Slot,
  type Tally,
  type VerdictPayload,
} from "../protocol";
import { createImageGenProvider } from "../providers/imagegen";
import { applyRound, decideMatch, decideRound, emptyTally, roundsToWin } from "./rules";

const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_GEN_ATTEMPTS = 2; // one automatic retry

export interface MatchInit {
  matchId: string;
  setId: string;
  players: Record<Slot, { deviceId: string; displayName: string }>;
  assetBase: string;
}

interface PlayerState {
  deviceId: string;
  displayName: string;
  connected: boolean;
  graceUntil: number | null;
  ready: boolean;
}

interface RoundDef {
  setRoundIndex: number;
  beforeKey: string;
  targetKey: string;
  beforeUrl: string;
  targetUrl: string;
  originalPrompt: string;
  modelId: string;
  modelParams: Record<string, unknown>;
  clue: string;
  tip: string;
}

interface Cast {
  prompt: string;
  castAt: number;
  late: boolean;
}

interface GenState {
  status: "pending" | "ok" | "failed";
  attempts: number;
  key?: string;
  error?: string;
}

interface RoundRuntime {
  n: number;
  intro: RoundIntroPayload;
  casts: Record<Slot, Cast | null>;
  gen: Partial<Record<Slot, GenState>>;
  reveal: RevealPayload | null;
}

interface MatchConfig {
  roundsTotal: number;
  castSeconds: number;
  castGraceSeconds: number;
  disconnectGraceSeconds: number;
  readyTimeoutSeconds: number;
  verdictSeconds: number;
  maxPromptChars: number;
}

interface State {
  v: 1;
  matchId: string;
  createdAt: number;
  setId: string;
  setTitle: string;
  assetBase: string;
  cfg: MatchConfig;
  teacherId: string;
  players: Record<Slot, PlayerState>;
  rounds: RoundDef[];
  phase: Phase;
  round: number;
  phaseDeadline: number | null;
  current: RoundRuntime | null;
  history: VerdictPayload[];
  tally: Tally;
  totals: Record<Slot, number>;
  ended: MatchEndPayload | null;
  endedAt: number | null;
  seq: number;
}

interface Attachment {
  slot: Slot;
  replaced?: boolean;
}

export class MatchDO extends DurableObject<Env> {
  private s: State | null = null;
  private assetCache = new Map<string, Uint8Array>();
  private decodedCache = new Map<string, RgbaImage>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)");
      const row = this.ctx.storage.sql.exec<{ json: string }>("SELECT json FROM state WHERE id = 1").toArray()[0];
      this.s = row ? (JSON.parse(row.json) as State) : null;
      // Answer pings without waking the object.
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
      // Resume interrupted pipeline work (generation/judging) if no alarm is pending.
      if (this.s && (this.s.phase === "generating" || this.s.phase === "judging") && (await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now());
      }
    });
  }

  // --- RPC -----------------------------------------------------------------

  /** Called once by the Matchmaker. Idempotent: a second call with the same matchId is a no-op. */
  async init(p: MatchInit): Promise<{ ok: true }> {
    if (this.s) return { ok: true };
    const app = readConfig(this.env);
    const manifest = await getManifest(this.env.BUCKET, p.setId);
    if (!manifest) throw new Error(`manifest missing for set ${p.setId}`);
    if (manifest.rounds.length < app.roundsPerMatch) throw new Error(`set ${p.setId} has ${manifest.rounds.length} rounds, need ${app.roundsPerMatch}`);
    const m = absolutizeManifest(manifest, p.assetBase);
    const now = Date.now();
    const grace = now + app.disconnectGraceSeconds * 1000;
    const teacher = loadTeacher(app.teacher);
    this.s = {
      v: 1,
      matchId: p.matchId,
      createdAt: now,
      setId: m.id,
      setTitle: m.title,
      assetBase: p.assetBase,
      cfg: matchConfig(app),
      teacherId: teacher.id,
      // Nobody is connected yet: the disconnect grace clock starts at pairing.
      players: {
        A: { ...p.players.A, connected: false, graceUntil: grace, ready: false },
        B: { ...p.players.B, connected: false, graceUntil: grace, ready: false },
      },
      rounds: m.rounds.slice(0, app.roundsPerMatch).map((r) => ({
        setRoundIndex: r.index,
        beforeKey: r.before.key,
        targetKey: r.target.key,
        beforeUrl: r.before.url,
        targetUrl: r.target.url,
        originalPrompt: r.originalPrompt,
        modelId: r.modelId,
        modelParams: r.modelParams ?? {},
        clue: r.clue,
        tip: r.tip,
      })),
      phase: "lobby",
      round: 0,
      phaseDeadline: null,
      current: null,
      history: [],
      tally: emptyTally(),
      totals: { A: 0, B: 0 },
      ended: null,
      endedAt: null,
      seq: 0,
    };
    this.persist();
    await this.scheduleAlarm();
    return { ok: true };
  }

  async snapshot(deviceId: string): Promise<MatchSnapshot | null | "forbidden"> {
    if (!this.s) return null;
    const slot = this.slotOf(deviceId);
    if (!slot) return "forbidden";
    return this.buildSnapshot(slot);
  }

  // --- WebSocket entry -----------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (!this.s) return new Response("match not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
    const slot = this.slotOf(request.headers.get("x-device-id") ?? "");
    if (!slot) return new Response("not a participant", { status: 403 });

    // One socket per player: a new connection replaces the old one.
    for (const old of this.ctx.getWebSockets(slot)) {
      try {
        old.serializeAttachment({ slot, replaced: true } satisfies Attachment);
        old.close(4000, "replaced");
      } catch {
        /* already closed */
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [slot]);
    server.serializeAttachment({ slot } satisfies Attachment);

    const s = this.s;
    const now = Date.now();
    if (s.phase !== "ended") {
      const p = s.players[slot];
      p.connected = true;
      p.graceUntil = null;
      if (s.phase === "lobby" && s.players[other(slot)].connected && s.phaseDeadline === null) {
        s.phaseDeadline = now + s.cfg.readyTimeoutSeconds * 1000;
      }
      this.persist();
    }

    this.sendTo(server, "match_found", {
      you: slot,
      opponent: { displayName: s.players[other(slot)].displayName },
      roundsTotal: s.cfg.roundsTotal,
      roundsToWin: roundsToWin(s.cfg.roundsTotal),
      config: {
        castSeconds: s.cfg.castSeconds,
        castGraceSeconds: s.cfg.castGraceSeconds,
        disconnectGraceSeconds: s.cfg.disconnectGraceSeconds,
        verdictSeconds: s.cfg.verdictSeconds,
        maxPromptChars: s.cfg.maxPromptChars,
      },
      snapshot: this.buildSnapshot(slot),
    });
    this.catchUp(server, slot);

    if (s.phase === "ended") {
      server.close(1000, "match over");
    } else {
      this.sendOpponentStatus(other(slot));
      // If the player reconnected after both had already readied, the lobby may start now.
      await this.maybeStartFromLobby();
      await this.scheduleAlarm();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const s = this.s;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!s || !att || att.replaced) return;
    const slot = att.slot;
    const msg = parseClientMessage(message);
    if (!msg) return this.sendError(ws, "bad_message", "Expected {type: ready|cast|ping}.");
    if (msg.type === "ping") return ws.send('{"type":"pong"}');
    if (s.phase === "ended") return this.sendError(ws, "match_over", "The duel is over.");

    if (msg.type === "ready") {
      if (s.phase !== "lobby" && s.phase !== "verdict") return;
      s.players[slot].ready = true;
      this.persist();
      this.sendOpponentStatus(other(slot));
      if (s.phase === "lobby") await this.maybeStartFromLobby();
      else if (s.players.A.ready && s.players.B.ready) await this.advanceAfterVerdict();
      await this.scheduleAlarm();
      return;
    }

    // cast
    const now = Date.now();
    const r = s.current;
    if ((s.phase !== "casting" && s.phase !== "intro") || !r || (s.phaseDeadline !== null && now > s.phaseDeadline)) {
      return this.sendError(ws, "wrong_phase", "Casting is closed.");
    }
    if (r.casts[slot]) return this.sendError(ws, "already_cast", "One spell per round.");
    const prompt = msg.prompt.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
    if (!prompt) return this.sendError(ws, "empty_prompt", "An empty scroll casts nothing.");
    if (prompt.length > s.cfg.maxPromptChars) return this.sendError(ws, "prompt_too_long", `Max ${s.cfg.maxPromptChars} characters.`);
    const cast: Cast = { prompt, castAt: now, late: now > r.intro.deadlineAt };
    r.casts[slot] = cast;
    this.persist();
    this.sendTo(ws, "cast_received", { round: r.n, prompt, castAt: now, late: cast.late });
    this.sendOpponentStatus(other(slot));
    if (r.casts.A && r.casts.B) this.closeCasting();
    await this.scheduleAlarm();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
    this.onSocketGone(ws);
    await this.scheduleAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.onSocketGone(ws);
    await this.scheduleAlarm();
  }

  // --- alarm: deadlines, disconnect grace, and the generation/judging pipeline ---

  async alarm(): Promise<void> {
    const s = this.s;
    if (!s) return;
    if (s.phase === "ended") {
      if (s.endedAt && Date.now() >= s.endedAt + CLEANUP_AFTER_MS) {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.s = null;
        return;
      }
      return this.scheduleAlarm();
    }

    // Up to a handful of transitions per alarm (e.g. casting → generating → judging → verdict).
    for (let step = 0; step < 8 && this.s && this.s.phase !== "ended"; step++) {
      const now = Date.now();
      const st = this.s;
      const gone = SLOTS.filter((sl) => !st.players[sl].connected && st.players[sl].graceUntil !== null && st.players[sl].graceUntil! <= now);
      if (gone.length === 2) {
        this.endMatch(null, "abandoned");
        break;
      }
      if (gone.length === 1) {
        this.endMatch(other(gone[0]), "forfeit_disconnect");
        break;
      }
      const phase = st.phase;
      if (phase === "lobby" && st.phaseDeadline !== null && now >= st.phaseDeadline) this.startRound(1);
      else if ((phase === "casting" || phase === "intro") && st.phaseDeadline !== null && now >= st.phaseDeadline) this.closeCasting();
      else if (phase === "generating") await this.runGeneration();
      else if (phase === "judging") await this.runJudging();
      else if (phase === "verdict" && st.phaseDeadline !== null && now >= st.phaseDeadline) await this.advanceAfterVerdict();
      else break;
    }
    await this.scheduleAlarm();
  }

  // --- phase transitions ---------------------------------------------------

  private async maybeStartFromLobby(): Promise<void> {
    const s = this.s!;
    if (s.phase !== "lobby") return;
    const both = s.players.A.connected && s.players.B.connected;
    if (both && s.players.A.ready && s.players.B.ready) this.startRound(1);
  }

  private startRound(n: number): void {
    const s = this.s!;
    const def = s.rounds[n - 1];
    const now = Date.now();
    const deadlineAt = now + s.cfg.castSeconds * 1000;
    const intro: RoundIntroPayload = {
      round: n,
      roundsTotal: s.cfg.roundsTotal,
      before: def.beforeUrl,
      target: def.targetUrl,
      clue: def.clue,
      tip: def.tip,
      deadlineAt,
      serverNow: now,
    };
    s.round = n;
    s.current = { n, intro, casts: { A: null, B: null }, gen: {}, reveal: null };
    s.players.A.ready = false;
    s.players.B.ready = false;
    s.phase = "intro";
    s.phaseDeadline = deadlineAt + s.cfg.castGraceSeconds * 1000;
    this.persist();
    this.broadcast("round_intro", intro);
    s.phase = "casting";
    this.persist();
  }

  /** Casting is over (both cast, or the deadline + grace passed). Empty = forfeit. */
  private closeCasting(): void {
    const s = this.s!;
    const r = s.current!;
    if (s.phase !== "casting" && s.phase !== "intro") return;
    const casters = SLOTS.filter((sl) => r.casts[sl]);
    const forfeits = SLOTS.filter((sl) => !r.casts[sl]);
    if (casters.length === 0) {
      this.finishRound({ voided: false, forfeits, scores: { A: null, B: null }, lesson: null, quotes: { A: null, B: null } });
      return;
    }
    for (const sl of casters) r.gen[sl] = { status: "pending", attempts: 0 };
    s.phase = "generating";
    s.phaseDeadline = null;
    this.persist();
    this.broadcast("generating", { round: r.n, players: casters, forfeits });
  }

  private async runGeneration(): Promise<void> {
    const s = this.s!;
    const r = s.current!;
    const def = s.rounds[r.n - 1];
    const provider = createImageGenProvider(this.env, readConfig(this.env));
    const before = await this.asset(def.beforeKey);

    await Promise.all(
      SLOTS.filter((sl) => r.gen[sl]?.status === "pending").map(async (sl) => {
        const g = r.gen[sl]!;
        while (g.status === "pending" && g.attempts < MAX_GEN_ATTEMPTS) {
          g.attempts++;
          this.persist(); // count the attempt before calling out, so a crash mid-call still uses it up
          try {
            const out = await provider.generate({ beforeImage: before, prompt: r.casts[sl]!.prompt, params: def.modelParams });
            const ext = sniffFormat(out.image) === "jpeg" ? "jpg" : "png";
            const key = `matches/${s.matchId}/r${r.n}/${sl}.${ext}`;
            await this.env.BUCKET.put(key, out.image, { httpMetadata: { contentType: out.meta.contentType } });
            this.assetCache.set(key, out.image);
            g.status = "ok";
            g.key = key;
            log("info", "image generated", { matchId: s.matchId, round: r.n, slot: sl, provider: out.meta.provider, ms: out.meta.ms, attempt: g.attempts });
          } catch (e) {
            g.error = e instanceof Error ? e.message : String(e);
            log("warn", "image generation failed", { matchId: s.matchId, round: r.n, slot: sl, attempt: g.attempts, error: g.error });
            if (g.attempts >= MAX_GEN_ATTEMPTS) g.status = "failed";
          }
          this.persist();
        }
      }),
    );

    if (SLOTS.some((sl) => r.gen[sl]?.status === "failed")) {
      const forfeits = SLOTS.filter((sl) => !r.casts[sl]);
      this.finishRound({ voided: true, forfeits, scores: { A: null, B: null }, lesson: null, quotes: { A: null, B: null } });
      return;
    }

    const results = {} as RevealPayload["results"];
    for (const sl of SLOTS) {
      const g = r.gen[sl];
      results[sl] = g?.status === "ok"
        ? { status: "ok", prompt: r.casts[sl]!.prompt, imageUrl: `${s.assetBase.replace(/\/+$/, "")}/${g.key}` }
        : { status: "forfeit", prompt: null, imageUrl: null };
    }
    r.reveal = { round: r.n, results };
    s.phase = "judging";
    this.persist();
    this.broadcast("reveal", r.reveal);
  }

  private async runJudging(): Promise<void> {
    const s = this.s!;
    const r = s.current!;
    const def = s.rounds[r.n - 1];
    const app = readConfig(this.env);
    const teacher = loadTeacher(s.teacherId);
    const [target, before] = await Promise.all([this.asset(def.targetKey), this.asset(def.beforeKey)]);
    const results: Record<Slot, Uint8Array | null> = { A: null, B: null };
    for (const sl of SLOTS) {
      const key = r.gen[sl]?.status === "ok" ? r.gen[sl]!.key! : null;
      results[sl] = key ? await this.asset(key) : null;
    }

    const whiskers = await runWhiskers(
      createJudgeProvider(this.env, app),
      {
        teacher,
        target,
        before,
        resultA: results.A,
        resultB: results.B,
        prompts: { A: r.casts.A?.prompt ?? null, B: r.casts.B?.prompt ?? null },
        clue: def.clue,
        originalPrompt: def.originalPrompt,
      },
      `${s.matchId}:${r.n}`,
    );

    const scores: Record<Slot, PlayerScore | null> = { A: null, B: null };
    for (const sl of SLOTS) {
      if (!results[sl] || !whiskers.scores[sl]) continue;
      let objective;
      try {
        objective = scoreObjective({ target: this.decoded(def.targetKey, target), result: results[sl]!, prompt: r.casts[sl]!.prompt, originalPrompt: def.originalPrompt });
        log("info", "objective scored", { matchId: s.matchId, round: r.n, slot: sl, raw: objective.raw, total: objective.total });
      } catch (e) {
        log("error", "objective scoring failed", { matchId: s.matchId, round: r.n, slot: sl, error: String(e) });
        objective = zeroObjective();
      }
      const { raw: _raw, ...obj } = objective as typeof objective & { raw?: unknown };
      const w = whiskers.scores[sl]!;
      scores[sl] = { objective: obj, whiskers: w, total: Math.round((obj.total + w.total) * 10) / 10 };
    }
    const forfeits = SLOTS.filter((sl) => !r.casts[sl]);
    const quotes: Record<Slot, string | null> = { A: scores.A?.whiskers.quote ?? null, B: scores.B?.whiskers.quote ?? null };
    this.finishRound({ voided: false, forfeits, scores, lesson: whiskers.lesson, quotes, teacher });
  }

  /** Builds and sends the verdict, records it, then ends the match or opens the verdict screen. */
  private finishRound(p: {
    voided: boolean;
    forfeits: Slot[];
    scores: Record<Slot, PlayerScore | null>;
    lesson: string | null;
    quotes: Record<Slot, string | null>;
    teacher?: TeacherConfig;
  }): void {
    const s = this.s!;
    const r = s.current!;
    const def = s.rounds[r.n - 1];
    const teacher = p.teacher ?? loadTeacher(s.teacherId);
    const result = decideRound({ voided: p.voided, forfeits: { A: p.forfeits.includes("A"), B: p.forfeits.includes("B") }, scores: p.scores });
    s.tally = applyRound(s.tally, result);
    s.totals = { A: round1(s.totals.A + result.totals.A), B: round1(s.totals.B + result.totals.B) };

    const seed = `${s.matchId}:${r.n}`;
    const quotes = { ...p.quotes };
    for (const sl of SLOTS) {
      if (p.voided) quotes[sl] = cannedQuote(teacher, "void", seed);
      else if (p.forfeits.includes(sl)) quotes[sl] = cannedQuote(teacher, "forfeit", `${seed}:${sl}`);
    }
    const decision = decideMatch(s.tally, r.n, s.cfg.roundsTotal, s.totals);
    const now = Date.now();
    const verdict: VerdictPayload = {
      round: r.n,
      outcome: result.outcome,
      scores: p.voided ? { A: null, B: null } : { A: p.forfeits.includes("A") ? null : p.scores.A, B: p.forfeits.includes("B") ? null : p.scores.B },
      roundWinner: result.winner,
      quotes,
      originalPrompt: def.originalPrompt,
      lesson: p.lesson ?? lessonFallback(teacher),
      tally: s.tally,
      nextRoundAt: decision.over ? null : now + s.cfg.verdictSeconds * 1000,
      teacher: { id: teacher.id, name: teacher.name },
    };
    s.history.push(verdict);
    s.players.A.ready = false;
    s.players.B.ready = false;
    s.phase = "verdict";
    s.phaseDeadline = verdict.nextRoundAt;
    this.persist();
    this.broadcast("verdict", verdict);
    this.ctx.waitUntil(this.recordRound(verdict, r, def));
    if (decision.over) this.endMatch(decision.winner, decision.reason!);
  }

  private async advanceAfterVerdict(): Promise<void> {
    const s = this.s!;
    if (s.phase !== "verdict") return;
    if (s.round < s.cfg.roundsTotal) this.startRound(s.round + 1);
    else {
      const d = decideMatch(s.tally, s.round, s.cfg.roundsTotal, s.totals);
      this.endMatch(d.winner, d.reason ?? "draw");
    }
  }

  private endMatch(winner: Slot | null, reason: MatchEndReason): void {
    const s = this.s!;
    if (s.phase === "ended") return;
    const payload: MatchEndPayload = { tally: s.tally, winner, reason, totals: s.totals };
    s.phase = "ended";
    s.phaseDeadline = null;
    s.ended = payload;
    s.endedAt = Date.now();
    this.persist();
    this.broadcast("match_end", payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "match over");
      } catch {
        /* ignore */
      }
    }
    log("info", "match ended", { matchId: s.matchId, winner, reason, tally: s.tally, totals: s.totals });
    this.ctx.waitUntil(
      this.env.DB.prepare("UPDATE matches SET status = 'ended', winner = ?1, end_reason = ?2, tally = ?3, totals = ?4, ended_at = ?5 WHERE id = ?6")
        .bind(winner, reason, JSON.stringify(s.tally), JSON.stringify(s.totals), s.endedAt, s.matchId)
        .run()
        .catch((e) => log("error", "D1 match update failed", { matchId: s.matchId, error: String(e) })),
    );
  }

  // --- helpers -------------------------------------------------------------

  private onSocketGone(ws: WebSocket): void {
    const s = this.s;
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!s || !att || att.replaced || s.phase === "ended") return;
    const slot = att.slot;
    const stillOpen = this.ctx.getWebSockets(slot).some((w) => w !== ws && w.readyState === WebSocket.OPEN);
    if (stillOpen) return;
    const p = s.players[slot];
    if (!p.connected) return;
    p.connected = false;
    p.graceUntil = Date.now() + s.cfg.disconnectGraceSeconds * 1000;
    this.persist();
    this.broadcastTo(other(slot), "opponent_disconnected", { graceUntil: p.graceUntil });
  }

  private async scheduleAlarm(): Promise<void> {
    const s = this.s;
    if (!s) return;
    const times: number[] = [];
    const now = Date.now();
    if (s.phase === "ended") times.push((s.endedAt ?? now) + CLEANUP_AFTER_MS);
    else {
      if (s.phase === "generating" || s.phase === "judging") times.push(now);
      if (s.phaseDeadline !== null && (s.phase === "lobby" || s.phase === "casting" || s.phase === "intro" || s.phase === "verdict")) times.push(s.phaseDeadline);
      for (const sl of SLOTS) if (!s.players[sl].connected && s.players[sl].graceUntil !== null) times.push(s.players[sl].graceUntil!);
    }
    if (times.length === 0) return;
    const at = Math.min(...times);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current !== at) await this.ctx.storage.setAlarm(at);
  }

  private persist(): void {
    if (!this.s) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO state (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json",
      JSON.stringify(this.s),
    );
  }

  private slotOf(deviceId: string): Slot | null {
    if (!this.s || !deviceId) return null;
    return SLOTS.find((sl) => this.s!.players[sl].deviceId === deviceId) ?? null;
  }

  private async asset(key: string): Promise<Uint8Array> {
    const hit = this.assetCache.get(key);
    if (hit) return hit;
    const obj = await this.env.BUCKET.get(key);
    if (!obj) throw new Error(`asset missing: ${key}`);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (this.assetCache.size > 16) this.assetCache.clear();
    this.assetCache.set(key, bytes);
    return bytes;
  }

  private decoded(key: string, bytes: Uint8Array): RgbaImage {
    let img = this.decodedCache.get(key);
    if (!img) {
      img = decodeImage(bytes);
      if (this.decodedCache.size > 8) this.decodedCache.clear();
      this.decodedCache.set(key, img);
    }
    return img;
  }

  private envelope<T extends ServerEventType>(type: T, payload: ServerEvents[T]): string {
    const s = this.s!;
    s.seq++;
    return JSON.stringify({ type, matchId: s.matchId, seq: s.seq, sentAt: Date.now(), ...payload });
  }

  private sendTo<T extends ServerEventType>(ws: WebSocket, type: T, payload: ServerEvents[T]): void {
    try {
      ws.send(this.envelope(type, payload));
    } catch {
      /* socket closed */
    }
  }

  private broadcastTo<T extends ServerEventType>(slot: Slot, type: T, payload: ServerEvents[T]): void {
    for (const ws of this.ctx.getWebSockets(slot)) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att?.replaced) this.sendTo(ws, type, payload);
    }
  }

  private broadcast<T extends ServerEventType>(type: T, payload: ServerEvents[T]): void {
    for (const sl of SLOTS) this.broadcastTo(sl, type, payload);
  }

  private sendError(ws: WebSocket, code: ServerEvents["error"]["code"], message: string): void {
    this.sendTo(ws, "error", { code, message });
  }

  private sendOpponentStatus(to: Slot): void {
    const s = this.s!;
    const them = s.players[other(to)];
    this.broadcastTo(to, "opponent_status", {
      connected: them.connected,
      cast: !!s.current?.casts[other(to)] && (s.phase === "casting" || s.phase === "intro" || s.phase === "generating"),
      ready: them.ready,
      graceUntil: them.connected ? null : them.graceUntil,
    });
  }

  /** After match_found on a (re)connect, replay what the client needs for the current phase. */
  private catchUp(ws: WebSocket, slot: Slot): void {
    const s = this.s!;
    const r = s.current;
    if (r && (s.phase === "casting" || s.phase === "intro")) {
      this.sendTo(ws, "round_intro", { ...r.intro, serverNow: Date.now() });
      const mine = r.casts[slot];
      if (mine) this.sendTo(ws, "cast_received", { round: r.n, prompt: mine.prompt, castAt: mine.castAt, late: mine.late });
    } else if (r && s.phase === "generating") {
      this.sendTo(ws, "generating", { round: r.n, players: SLOTS.filter((sl) => r.gen[sl]), forfeits: SLOTS.filter((sl) => !r.casts[sl]) });
    } else if (r && s.phase === "judging" && r.reveal) {
      this.sendTo(ws, "reveal", r.reveal);
    } else if (s.phase === "verdict" && s.history.length) {
      this.sendTo(ws, "verdict", s.history[s.history.length - 1]);
    } else if (s.phase === "ended" && s.ended) {
      this.sendTo(ws, "match_end", s.ended);
    }
    this.sendOpponentStatus(slot);
  }

  private buildSnapshot(slot: Slot): MatchSnapshot {
    const s = this.s!;
    const r = s.current;
    const teacher = loadTeacher(s.teacherId);
    const castOpen = s.phase === "casting" || s.phase === "intro" || s.phase === "generating";
    const view = (sl: Slot) => ({
      displayName: s.players[sl].displayName,
      connected: s.players[sl].connected,
      cast: castOpen && !!r?.casts[sl],
      ready: s.players[sl].ready,
      graceUntil: s.players[sl].connected ? null : s.players[sl].graceUntil,
    });
    const mine = r?.casts[slot];
    return {
      matchId: s.matchId,
      you: slot,
      phase: s.phase,
      round: s.round,
      roundsTotal: s.cfg.roundsTotal,
      roundsToWin: roundsToWin(s.cfg.roundsTotal),
      set: { id: s.setId, title: s.setTitle },
      teacher: { id: teacher.id, name: teacher.name },
      players: { A: view("A"), B: view("B") },
      current: r ? r.intro : null,
      yourCast: mine && castOpen ? { prompt: mine.prompt, castAt: mine.castAt } : null,
      lastReveal: r?.reveal ?? null,
      history: s.history,
      tally: s.tally,
      ended: s.ended,
      serverNow: Date.now(),
    };
  }

  private async recordRound(v: VerdictPayload, r: RoundRuntime, def: RoundDef): Promise<void> {
    const s = this.s!;
    const now = Date.now();
    try {
      const stmts: D1PreparedStatement[] = [
        this.env.DB.prepare(
          `INSERT OR REPLACE INTO match_rounds (match_id, round_index, set_id, set_round_index, outcome, round_winner, prompt_a, prompt_b,
             result_a_key, result_b_key, quote_a, quote_b, lesson, total_a, total_b, teacher_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
        ).bind(
          s.matchId, v.round, s.setId, def.setRoundIndex, v.outcome, v.roundWinner,
          r.casts.A?.prompt ?? null, r.casts.B?.prompt ?? null,
          r.gen.A?.key ?? null, r.gen.B?.key ?? null,
          v.quotes.A, v.quotes.B, v.lesson,
          v.scores.A?.total ?? null, v.scores.B?.total ?? null, v.teacher.id, now,
        ),
      ];
      for (const sl of SLOTS) {
        const sc = v.scores[sl];
        if (!sc) continue;
        for (const [agent, a] of [["objective", sc.objective], ["whiskers", sc.whiskers]] as const) {
          const rows: Array<[string, number, number]> = [["_total", a.total, 50], ...Object.entries(a.parts).map(([k, p]) => [k, p.score, p.max] as [string, number, number])];
          for (const [key, score, max] of rows) {
            stmts.push(
              this.env.DB.prepare(
                "INSERT OR REPLACE INTO round_scores (match_id, round_index, slot, agent, part_key, score, max) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
              ).bind(s.matchId, v.round, sl, agent, key, score, max),
            );
          }
        }
      }
      await this.env.DB.batch(stmts);
    } catch (e) {
      log("error", "D1 round write failed", { matchId: s.matchId, round: v.round, error: String(e) });
    }
  }
}

function matchConfig(c: AppConfig): MatchConfig {
  return {
    roundsTotal: c.roundsPerMatch,
    castSeconds: c.castSeconds,
    castGraceSeconds: c.castGraceSeconds,
    disconnectGraceSeconds: c.disconnectGraceSeconds,
    readyTimeoutSeconds: c.readyTimeoutSeconds,
    verdictSeconds: c.verdictSeconds,
    maxPromptChars: c.maxPromptChars,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
