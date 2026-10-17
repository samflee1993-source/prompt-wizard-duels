import { describe, expect, it } from "vitest";
import { QUEUE_RECORD_TTL_MS, findExpired, findStale, nextWake, pairAll, pickPair, positionOf, utcDayStart, type QueueEntry } from "../src/matchmaker/logic";

const T0 = 1_760_000_000_000;
const TIMEOUT = 60_000;

const entry = (deviceId: string, joinedAt: number, over: Partial<QueueEntry> = {}): QueueEntry => ({
  deviceId,
  displayName: deviceId,
  state: "waiting",
  joinedAt,
  expiresAt: joinedAt + TIMEOUT,
  matchId: null,
  updatedAt: joinedAt,
  ...over,
});

describe("pairing", () => {
  it("pairs the two longest-waiting players (FIFO)", () => {
    const q = [entry("c", T0 + 3000), entry("a", T0 + 1000), entry("d", T0 + 4000), entry("b", T0 + 2000)];
    const p = pickPair(q, T0 + 5000)!;
    expect(p.map((e) => e.deviceId)).toEqual(["a", "b"]);
  });

  it("needs two live players", () => {
    expect(pickPair([], T0)).toBeNull();
    expect(pickPair([entry("a", T0)], T0)).toBeNull();
  });

  it("skips matched, pairing and expired entries", () => {
    const q = [
      entry("old", T0 - 2 * TIMEOUT), // expired by time
      entry("m", T0, { state: "matched", matchId: "x" }),
      entry("p", T0, { state: "pairing" }),
      entry("a", T0 + 10),
      entry("b", T0 + 20),
    ];
    expect(pickPair(q, T0 + 100)!.map((e) => e.deviceId)).toEqual(["a", "b"]);
  });

  it("pairAll drains the queue head-first and leaves an odd player waiting", () => {
    const q = ["a", "b", "c", "d", "e"].map((id, i) => entry(id, T0 + i));
    const pairs = pairAll(q, T0 + 10);
    expect(pairs.map((p) => p.map((e) => e.deviceId).join("+"))).toEqual(["a+b", "c+d"]);
  });

  it("ties on joinedAt break by deviceId so pairing is deterministic", () => {
    const q = [entry("z", T0), entry("y", T0), entry("x", T0)];
    expect(pickPair(q, T0)!.map((e) => e.deviceId)).toEqual(["x", "y"]);
  });

  it("reports 1-based queue position among live players", () => {
    const q = [entry("a", T0), entry("b", T0 + 1), entry("gone", T0 - 2 * TIMEOUT)];
    expect(positionOf(q, "b", T0 + 2)).toBe(2);
    expect(positionOf(q, "gone", T0 + 2)).toBeNull();
  });
});

describe("expiry", () => {
  it("expires waiting entries at the timeout, not before", () => {
    const q = [entry("a", T0), entry("b", T0 + 30_000)];
    expect(findExpired(q, T0 + TIMEOUT - 1)).toEqual([]);
    expect(findExpired(q, T0 + TIMEOUT).map((e) => e.deviceId)).toEqual(["a"]);
    expect(findExpired(q, T0 + 30_000 + TIMEOUT).map((e) => e.deviceId)).toEqual(["a", "b"]);
  });

  it("an expired player is never paired", () => {
    const q = [entry("a", T0), entry("b", T0 + 50_000)];
    expect(pickPair(q, T0 + TIMEOUT + 1)).toBeNull();
  });

  it("matched/expired records are kept for the TTL, then become stale", () => {
    const q = [entry("m", T0, { state: "matched", updatedAt: T0 }), entry("e", T0, { state: "expired", updatedAt: T0 })];
    expect(findStale(q, T0 + QUEUE_RECORD_TTL_MS)).toEqual([]);
    expect(findStale(q, T0 + QUEUE_RECORD_TTL_MS + 1).length).toBe(2);
  });

  it("nextWake is the earliest expiry or cleanup time", () => {
    const q = [entry("a", T0), entry("b", T0 + 5000), entry("m", T0, { state: "matched", updatedAt: T0 })];
    expect(nextWake(q, T0)).toBe(T0 + TIMEOUT);
    expect(nextWake([], T0)).toBeNull();
  });

  it("utcDayStart is UTC midnight", () => {
    expect(utcDayStart(Date.UTC(2026, 9, 16, 23, 59, 59))).toBe(Date.UTC(2026, 9, 16));
  });
});
