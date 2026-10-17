// Pure matchmaking rules (FIFO pairing + expiry). No I/O; unit-tested in test/matchmaker.test.ts.

export type QueueState = "waiting" | "pairing" | "matched" | "expired";

export interface QueueEntry {
  deviceId: string;
  displayName: string;
  state: QueueState;
  joinedAt: number;
  expiresAt: number;
  matchId: string | null;
  updatedAt: number;
}

/** How long matched/expired rows stay readable by GET /queue/status. */
export const QUEUE_RECORD_TTL_MS = 10 * 60 * 1000;

const isLive = (e: QueueEntry, now: number) => e.state === "waiting" && e.expiresAt > now;

/** FIFO order: earliest joinedAt first, deviceId as a stable tiebreak. */
export function fifo(a: QueueEntry, b: QueueEntry): number {
  return a.joinedAt - b.joinedAt || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
}

/** Waiting entries whose timeout has passed. */
export function findExpired(entries: QueueEntry[], now: number): QueueEntry[] {
  return entries.filter((e) => e.state === "waiting" && e.expiresAt <= now);
}

/** The two longest-waiting live entries (distinct devices), or null. */
export function pickPair(entries: QueueEntry[], now: number): [QueueEntry, QueueEntry] | null {
  const live = entries.filter((e) => isLive(e, now)).sort(fifo);
  if (live.length < 2) return null;
  const a = live[0];
  const b = live.find((e) => e.deviceId !== a.deviceId);
  return b ? [a, b] : null;
}

/** Repeatedly pairs the queue head. Returns pairs in FIFO order. */
export function pairAll(entries: QueueEntry[], now: number): Array<[QueueEntry, QueueEntry]> {
  const pool = entries.map((e) => ({ ...e }));
  const pairs: Array<[QueueEntry, QueueEntry]> = [];
  for (;;) {
    const p = pickPair(pool, now);
    if (!p) return pairs;
    p[0].state = "pairing";
    p[1].state = "pairing";
    pairs.push(p);
  }
}

/** 1-based place in line among live waiting entries. */
export function positionOf(entries: QueueEntry[], deviceId: string, now: number): number | null {
  const live = entries.filter((e) => isLive(e, now)).sort(fifo);
  const i = live.findIndex((e) => e.deviceId === deviceId);
  return i < 0 ? null : i + 1;
}

/** Rows that can be deleted: matched/expired and older than the TTL. */
export function findStale(entries: QueueEntry[], now: number): QueueEntry[] {
  return entries.filter((e) => (e.state === "matched" || e.state === "expired") && now - e.updatedAt > QUEUE_RECORD_TTL_MS);
}

/** When the matchmaker alarm should next fire, or null when nothing is pending. */
export function nextWake(entries: QueueEntry[], now: number): number | null {
  let t: number | null = null;
  for (const e of entries) {
    const at = e.state === "waiting" ? e.expiresAt : e.state === "matched" || e.state === "expired" ? e.updatedAt + QUEUE_RECORD_TTL_MS + 1 : null;
    if (at !== null && (t === null || at < t)) t = at;
  }
  return t === null ? null : Math.max(t, now + 1);
}

/** UTC midnight of the day containing `now`, in epoch ms. */
export function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
