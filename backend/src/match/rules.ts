// Pure match rules: round winner, tally, match decision. No I/O; unit-tested in test/rules.test.ts.
import type { MatchEndReason, PlayerScore, RoundOutcome, Slot, Tally } from "../protocol";

export const roundsToWin = (roundsTotal: number): number => Math.ceil(roundsTotal / 2);

export const emptyTally = (): Tally => ({ A: 0, B: 0, ties: 0, voids: 0 });

export interface RoundResult {
  outcome: RoundOutcome;
  winner: Slot | null;
  totals: Record<Slot, number>; // 0 for a forfeiting / void player
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Decides one round.
 * - void: generation failed → no points.
 * - both forfeited → no_contest.
 * - one forfeited → the other wins (their score still counts toward totals).
 * - both scored → higher total wins; equal → tie.
 */
export function decideRound(input: {
  voided: boolean;
  forfeits: Record<Slot, boolean>;
  scores: Record<Slot, PlayerScore | null>;
}): RoundResult {
  const totals = { A: round1(input.scores.A?.total ?? 0), B: round1(input.scores.B?.total ?? 0) };
  if (input.voided) return { outcome: "void", winner: null, totals: { A: 0, B: 0 } };
  const fa = input.forfeits.A;
  const fb = input.forfeits.B;
  if (fa && fb) return { outcome: "no_contest", winner: null, totals: { A: 0, B: 0 } };
  if (fa) return { outcome: "forfeit", winner: "B", totals: { A: 0, B: totals.B } };
  if (fb) return { outcome: "forfeit", winner: "A", totals: { A: totals.A, B: 0 } };
  if (totals.A > totals.B) return { outcome: "scored", winner: "A", totals };
  if (totals.B > totals.A) return { outcome: "scored", winner: "B", totals };
  return { outcome: "scored", winner: null, totals };
}

export function applyRound(tally: Tally, r: RoundResult): Tally {
  const t = { ...tally };
  if (r.outcome === "void" || r.outcome === "no_contest") t.voids++;
  else if (r.winner) t[r.winner]++;
  else t.ties++;
  return t;
}

export interface MatchDecision {
  over: boolean;
  winner: Slot | null;
  reason: MatchEndReason | null;
}

/**
 * Called after every round.
 * First to ceil(roundsTotal/2) round wins takes the match immediately.
 * When every round has been played without that, higher total score wins; equal → draw.
 */
export function decideMatch(tally: Tally, roundsPlayed: number, roundsTotal: number, totals: Record<Slot, number>): MatchDecision {
  const need = roundsToWin(roundsTotal);
  if (tally.A >= need && tally.A > tally.B) return { over: true, winner: "A", reason: "majority" };
  if (tally.B >= need && tally.B > tally.A) return { over: true, winner: "B", reason: "majority" };
  if (roundsPlayed < roundsTotal) return { over: false, winner: null, reason: null };
  // All rounds played and nobody reached the majority (tied/void rounds; or, with an even
  // roundsTotal, both players at ceil(n/2)). Per the product rule, total score decides, not round count.
  const a = round1(totals.A);
  const b = round1(totals.B);
  if (a > b) return { over: true, winner: "A", reason: "score_tiebreak" };
  if (b > a) return { over: true, winner: "B", reason: "score_tiebreak" };
  return { over: true, winner: null, reason: "draw" };
}
