import { describe, expect, it } from "vitest";
import { applyRound, decideMatch, decideRound, emptyTally, roundsToWin, type RoundResult } from "../src/match/rules";
import type { PlayerScore, Slot, Tally } from "../src/protocol";

const score = (total: number): PlayerScore => ({
  objective: { total: total / 2, parts: {} },
  whiskers: { total: total / 2, parts: {}, quote: "" },
  total,
});

const scored = (a: number, b: number) => decideRound({ voided: false, forfeits: { A: false, B: false }, scores: { A: score(a), B: score(b) } });

/** Plays a sequence of rounds until decideMatch says it's over; returns the decision and rounds used. */
function playOut(rounds: RoundResult[], roundsTotal: number) {
  let tally: Tally = emptyTally();
  const totals: Record<Slot, number> = { A: 0, B: 0 };
  for (let i = 0; i < rounds.length; i++) {
    tally = applyRound(tally, rounds[i]);
    totals.A += rounds[i].totals.A;
    totals.B += rounds[i].totals.B;
    const d = decideMatch(tally, i + 1, roundsTotal, totals);
    if (d.over) return { ...d, played: i + 1, tally, totals };
  }
  return { over: false, winner: null, reason: null, played: rounds.length, tally, totals };
}

describe("roundsToWin", () => {
  it("is ceil(rounds/2)", () => {
    expect(roundsToWin(3)).toBe(2);
    expect(roundsToWin(5)).toBe(3);
    expect(roundsToWin(1)).toBe(1);
  });
});

describe("decideRound", () => {
  it("higher total wins; equal totals tie", () => {
    expect(scored(80, 60).winner).toBe("A");
    expect(scored(40, 70).winner).toBe("B");
    const tie = scored(55, 55);
    expect(tie.outcome).toBe("scored");
    expect(tie.winner).toBeNull();
  });

  it("a forfeit hands the round to the other player", () => {
    const r = decideRound({ voided: false, forfeits: { A: true, B: false }, scores: { A: null, B: score(10) } });
    expect(r).toMatchObject({ outcome: "forfeit", winner: "B", totals: { A: 0, B: 10 } });
  });

  it("both forfeiting is a no-contest", () => {
    const r = decideRound({ voided: false, forfeits: { A: true, B: true }, scores: { A: null, B: null } });
    expect(r).toMatchObject({ outcome: "no_contest", winner: null });
  });

  it("void gives no points to either player", () => {
    const r = decideRound({ voided: true, forfeits: { A: false, B: false }, scores: { A: score(90), B: score(10) } });
    expect(r).toMatchObject({ outcome: "void", winner: null, totals: { A: 0, B: 0 } });
  });
});

describe("decideMatch — 3 rounds", () => {
  it("2-0 ends after round 2 by majority", () => {
    const d = playOut([scored(80, 50), scored(70, 60), scored(10, 90)], 3);
    expect(d).toMatchObject({ over: true, winner: "A", reason: "majority", played: 2 });
  });

  it("2-1 goes the distance", () => {
    const d = playOut([scored(80, 50), scored(50, 70), scored(10, 90)], 3);
    expect(d).toMatchObject({ over: true, winner: "B", reason: "majority", played: 3 });
  });

  it("1-0 with two tied rounds: no majority, higher total score wins", () => {
    // A wins round 1 by 1 point; the tie rounds don't move totals apart.
    const d = playOut([scored(51, 50), scored(60, 60), scored(40, 40)], 3);
    expect(d).toMatchObject({ over: true, winner: "A", reason: "score_tiebreak", played: 3 });
  });

  it("no majority with a void round: total score decides", () => {
    // A: 1 round win, B: 0, one tie, one void → nobody reached 2 → totals decide (A 150 vs B 149).
    const d = playOut(
      [scored(51, 50), scored(99, 99), decideRound({ voided: true, forfeits: { A: false, B: false }, scores: { A: null, B: null } })],
      3,
    );
    expect(d.reason).toBe("score_tiebreak");
    expect(d.winner).toBe("A");
  });

  it("all ties and equal totals is a draw", () => {
    const d = playOut([scored(50, 50), scored(70, 70), scored(30, 30)], 3);
    expect(d).toMatchObject({ over: true, winner: null, reason: "draw", played: 3 });
  });

  it("all voids is a draw", () => {
    const v = decideRound({ voided: true, forfeits: { A: false, B: false }, scores: { A: null, B: null } });
    const d = playOut([v, v, v], 3);
    expect(d).toMatchObject({ over: true, winner: null, reason: "draw", tally: { voids: 3 } });
  });
});

describe("decideMatch — 5 rounds", () => {
  it("3-0 ends after round 3", () => {
    const d = playOut([scored(80, 50), scored(80, 50), scored(80, 50), scored(1, 99), scored(1, 99)], 5);
    expect(d).toMatchObject({ over: true, winner: "A", reason: "majority", played: 3 });
  });

  it("3-2 is decided in round 5", () => {
    const d = playOut([scored(80, 50), scored(50, 80), scored(80, 50), scored(50, 80), scored(50, 80)], 5);
    expect(d).toMatchObject({ over: true, winner: "B", reason: "majority", played: 5 });
  });

  it("2-2 with a tie: score tiebreak", () => {
    const d = playOut([scored(90, 50), scored(50, 60), scored(90, 50), scored(50, 60), scored(40, 40)], 5);
    expect(d).toMatchObject({ over: true, winner: "A", reason: "score_tiebreak", played: 5 });
  });

  it("2-2 with a void: the player with more total points wins, not the round count", () => {
    const v = decideRound({ voided: true, forfeits: { A: false, B: false }, scores: { A: null, B: null } });
    const d = playOut([scored(51, 50), scored(51, 50), scored(10, 95), scored(10, 95), v], 5);
    expect(d).toMatchObject({ over: true, winner: "B", reason: "score_tiebreak", tally: { A: 2, B: 2, voids: 1 } });
  });

  it("2-2 with a tie and identical totals: draw", () => {
    const d = playOut([scored(60, 50), scored(50, 60), scored(60, 50), scored(50, 60), scored(40, 40)], 5);
    expect(d).toMatchObject({ over: true, winner: null, reason: "draw", played: 5 });
  });

  it("forfeits count as round wins for the opponent", () => {
    const ff = decideRound({ voided: false, forfeits: { A: true, B: false }, scores: { A: null, B: score(20) } });
    const d = playOut([ff, ff, ff], 5);
    expect(d).toMatchObject({ over: true, winner: "B", reason: "majority", played: 3 });
  });
});
