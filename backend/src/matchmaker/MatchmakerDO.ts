// The one global lobby. FIFO waiting list in SQLite; pairs on join and on alarm; expires stale entries.
import { DurableObject } from "cloudflare:workers";
import { pickRandomSet } from "../challenges/repo";
import { log, readConfig } from "../config";
import { findExpired, findStale, nextWake, pickPair, positionOf, utcDayStart, type QueueEntry } from "./logic";

export type QueueStatus =
  | { status: "idle" }
  | { status: "waiting"; joinedAt: number; expiresAt: number; position: number | null; notice?: string }
  | { status: "matched"; matchId: string }
  | { status: "expired"; joinedAt: number; expiresAt: number };

export type JoinResult = QueueStatus | { error: "daily_cap_reached" | "no_challenge_sets" };

interface Row {
  device_id: string;
  display_name: string;
  state: QueueEntry["state"];
  joined_at: number;
  expires_at: number;
  match_id: string | null;
  updated_at: number;
  asset_base: string;
}

export class MatchmakerDO extends DurableObject<Env> {
  private notice: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS queue (
          device_id    TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          state        TEXT NOT NULL,
          joined_at    INTEGER NOT NULL,
          expires_at   INTEGER NOT NULL,
          match_id     TEXT,
          updated_at   INTEGER NOT NULL,
          asset_base   TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_queue_state ON queue (state, joined_at);
      `);
      // A crash mid-pairing leaves rows in 'pairing'; put them back in line.
      this.ctx.storage.sql.exec("UPDATE queue SET state = 'waiting' WHERE state = 'pairing'");
    });
  }

  // --- RPC -----------------------------------------------------------------

  async join(deviceId: string, displayName: string, assetBase: string): Promise<JoinResult> {
    const cfg = readConfig(this.env);
    const now = Date.now();
    if (await this.capReached(cfg.dailyDuelCap, now)) return { error: "daily_cap_reached" };
    this.notice = null;

    const row = this.get(deviceId);
    if (row && row.state === "waiting" && row.expires_at > now) {
      // Already in line: keep the place, refresh the name.
      this.sql("UPDATE queue SET display_name = ?, asset_base = ?, updated_at = ? WHERE device_id = ?", displayName, assetBase, now, deviceId);
    } else if (row && row.state === "pairing") {
      // A match is being created for this device right now.
    } else {
      this.sql(
        `INSERT INTO queue (device_id, display_name, state, joined_at, expires_at, match_id, updated_at, asset_base)
         VALUES (?, ?, 'waiting', ?, ?, NULL, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET display_name = excluded.display_name, state = 'waiting',
           joined_at = excluded.joined_at, expires_at = excluded.expires_at, match_id = NULL,
           updated_at = excluded.updated_at, asset_base = excluded.asset_base`,
        deviceId, displayName, now, now + cfg.queueTimeoutSeconds * 1000, now, assetBase,
      );
    }
    await this.pairAvailable();
    await this.reschedule();
    if (this.notice === "no_challenge_sets") return { error: "no_challenge_sets" };
    return this.status(deviceId);
  }

  async status(deviceId: string): Promise<QueueStatus> {
    const now = Date.now();
    const row = this.get(deviceId);
    if (!row) return { status: "idle" };
    if (row.state === "matched" && row.match_id) return { status: "matched", matchId: row.match_id };
    if (row.state === "expired" || (row.state === "waiting" && row.expires_at <= now)) {
      return { status: "expired", joinedAt: row.joined_at, expiresAt: row.expires_at };
    }
    const position = positionOf(this.all(), deviceId, now);
    return {
      status: "waiting",
      joinedAt: row.joined_at,
      expiresAt: row.expires_at,
      position,
      ...(this.notice ? { notice: this.notice } : {}),
    };
  }

  async leave(deviceId: string): Promise<QueueStatus> {
    const row = this.get(deviceId);
    // Don't yank someone out mid-pairing; the match is about to exist.
    if (row && row.state !== "pairing") this.sql("DELETE FROM queue WHERE device_id = ?", deviceId);
    await this.reschedule();
    return { status: "idle" };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const e of findExpired(this.all(), now)) {
      this.sql("UPDATE queue SET state = 'expired', updated_at = ? WHERE device_id = ? AND state = 'waiting'", now, e.deviceId);
    }
    await this.pairAvailable();
    for (const e of findStale(this.all(), now)) this.sql("DELETE FROM queue WHERE device_id = ?", e.deviceId);
    await this.reschedule();
  }

  // --- internals -----------------------------------------------------------

  private async pairAvailable(): Promise<void> {
    for (let guard = 0; guard < 50; guard++) {
      const now = Date.now();
      const pair = pickPair(this.all(), now);
      if (!pair) return;
      const [a, b] = pair;
      // Claim both rows synchronously, before any await, so a concurrent join can't pick them too.
      this.sql("UPDATE queue SET state = 'pairing', updated_at = ? WHERE device_id IN (?, ?)", now, a.deviceId, b.deviceId);
      try {
        const matchId = await this.createMatch(a.deviceId, b.deviceId);
        if (!matchId) {
          this.sql("UPDATE queue SET state = 'waiting' WHERE device_id IN (?, ?) AND state = 'pairing'", a.deviceId, b.deviceId);
          return;
        }
        this.notice = null;
        this.sql("UPDATE queue SET state = 'matched', match_id = ?, updated_at = ? WHERE device_id IN (?, ?)", matchId, Date.now(), a.deviceId, b.deviceId);
      } catch (e) {
        log("error", "pairing failed", { error: String(e), a: a.deviceId, b: b.deviceId });
        this.sql("UPDATE queue SET state = 'waiting' WHERE device_id IN (?, ?) AND state = 'pairing'", a.deviceId, b.deviceId);
        return;
      }
    }
  }

  private async createMatch(deviceA: string, deviceB: string): Promise<string | null> {
    const cfg = readConfig(this.env);
    const now = Date.now();
    if (await this.capReached(cfg.dailyDuelCap, now)) {
      this.notice = "daily_cap_reached";
      return null;
    }
    const set = await pickRandomSet(this.env.DB, cfg.roundsPerMatch);
    if (!set) {
      this.notice = "no_challenge_sets";
      log("warn", "no challenge set has enough rounds", { roundsPerMatch: cfg.roundsPerMatch });
      return null;
    }
    const ra = this.get(deviceA)!;
    const rb = this.get(deviceB)!;
    // Randomise who is A so FIFO order doesn't always make the earlier joiner Wizard A.
    const [pa, pb] = crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? [ra, rb] : [rb, ra];
    const matchId = crypto.randomUUID();
    const stub = this.env.MATCH.getByName(matchId);
    await stub.init({
      matchId,
      setId: set.id,
      players: {
        A: { deviceId: pa.device_id, displayName: pa.display_name },
        B: { deviceId: pb.device_id, displayName: pb.display_name },
      },
      assetBase: pa.asset_base || pb.asset_base,
    });
    await this.env.DB.prepare(
      "INSERT INTO matches (id, set_id, player_a, player_b, rounds_total, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)",
    )
      .bind(matchId, set.id, pa.device_id, pb.device_id, cfg.roundsPerMatch, now)
      .run();
    log("info", "match created", { matchId, setId: set.id, a: pa.device_id, b: pb.device_id });
    return matchId;
  }

  private async capReached(cap: number, now: number): Promise<boolean> {
    if (!cap) return false;
    const n = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM matches WHERE created_at >= ?1").bind(utcDayStart(now)).first<number>("n");
    return (n ?? 0) >= cap;
  }

  private async reschedule(): Promise<void> {
    const at = nextWake(this.all(), Date.now());
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  private sql(query: string, ...bindings: unknown[]) {
    return this.ctx.storage.sql.exec(query, ...(bindings as (string | number | null)[]));
  }

  private get(deviceId: string): Row | null {
    const rows = this.ctx.storage.sql.exec<Row & Record<string, SqlStorageValue>>("SELECT * FROM queue WHERE device_id = ?", deviceId).toArray();
    return rows[0] ?? null;
  }

  private all(): QueueEntry[] {
    return this.ctx.storage.sql
      .exec<Row & Record<string, SqlStorageValue>>("SELECT * FROM queue")
      .toArray()
      .map((r) => ({
        deviceId: r.device_id,
        displayName: r.display_name,
        state: r.state,
        joinedAt: r.joined_at,
        expiresAt: r.expires_at,
        matchId: r.match_id,
        updatedAt: r.updated_at,
      }));
  }
}
