// Wire types shared by the Worker, the Durable Objects and the test harness. Mirrors CONTRACT.md.

export type Slot = "A" | "B";
export const SLOTS: readonly Slot[] = ["A", "B"] as const;
export const other = (s: Slot): Slot => (s === "A" ? "B" : "A");

export type Phase = "lobby" | "intro" | "casting" | "generating" | "judging" | "verdict" | "ended";

export interface ScorePart {
  score: number;
  max: number;
  label?: string;
}

export interface AgentScore {
  total: number;
  parts: Record<string, ScorePart>;
}

export interface WhiskersScore extends AgentScore {
  quote: string;
  fallback?: boolean;
}

export interface PlayerScore {
  objective: AgentScore;
  whiskers: WhiskersScore;
  total: number;
}

export interface Tally {
  A: number;
  B: number;
  ties: number;
  voids: number;
}

export type RoundOutcome = "scored" | "forfeit" | "no_contest" | "void";

export type MatchEndReason = "majority" | "score_tiebreak" | "draw" | "forfeit_disconnect" | "abandoned";

export interface RoundIntroPayload {
  round: number;
  roundsTotal: number;
  before: string;
  target: string;
  clue: string;
  tip: string;
  deadlineAt: number;
  serverNow: number;
}

export interface RevealResult {
  status: "ok" | "forfeit" | "failed";
  prompt: string | null;
  imageUrl: string | null;
}

export interface RevealPayload {
  round: number;
  results: Record<Slot, RevealResult>;
}

export interface VerdictPayload {
  round: number;
  outcome: RoundOutcome;
  scores: Record<Slot, PlayerScore | null>;
  roundWinner: Slot | null;
  quotes: Record<Slot, string | null>;
  originalPrompt: string;
  lesson: string;
  tally: Tally;
  nextRoundAt: number | null;
  teacher: { id: string; name: string };
}

export interface MatchEndPayload {
  tally: Tally;
  winner: Slot | null;
  reason: MatchEndReason;
  totals: Record<Slot, number>;
}

export interface PlayerView {
  displayName: string;
  connected: boolean;
  cast: boolean;
  ready: boolean;
  graceUntil: number | null;
}

export interface MatchSnapshot {
  matchId: string;
  you: Slot;
  phase: Phase;
  round: number;
  roundsTotal: number;
  roundsToWin: number;
  set: { id: string; title: string };
  teacher: { id: string; name: string };
  players: Record<Slot, PlayerView>;
  current: RoundIntroPayload | null;
  yourCast: { prompt: string; castAt: number } | null;
  lastReveal: RevealPayload | null;
  history: VerdictPayload[];
  tally: Tally;
  ended: MatchEndPayload | null;
  serverNow: number;
}

export type ClientMessage = { type: "ready" } | { type: "cast"; prompt: string } | { type: "ping" };

export type ErrorCode = "bad_message" | "wrong_phase" | "already_cast" | "empty_prompt" | "prompt_too_long" | "match_over";

/** Server event payloads, keyed by `type`. The envelope adds matchId, seq, sentAt. */
export interface ServerEvents {
  match_found: {
    you: Slot;
    opponent: { displayName: string };
    roundsTotal: number;
    roundsToWin: number;
    config: { castSeconds: number; castGraceSeconds: number; disconnectGraceSeconds: number; verdictSeconds: number; maxPromptChars: number };
    snapshot: MatchSnapshot;
  };
  round_intro: RoundIntroPayload;
  cast_received: { round: number; prompt: string; castAt: number; late: boolean };
  opponent_status: { connected: boolean; cast: boolean; ready: boolean; graceUntil: number | null };
  generating: { round: number; players: Slot[]; forfeits: Slot[] };
  reveal: RevealPayload;
  verdict: VerdictPayload;
  match_end: MatchEndPayload;
  opponent_disconnected: { graceUntil: number };
  error: { code: ErrorCode; message: string };
}

export type ServerEventType = keyof ServerEvents;

export type ServerMessage<T extends ServerEventType = ServerEventType> = { type: T; matchId: string; seq: number; sentAt: number } & ServerEvents[T];

export function parseClientMessage(raw: string | ArrayBuffer): ClientMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const m = JSON.parse(raw) as { type?: unknown; prompt?: unknown };
    if (m.type === "ready" || m.type === "ping") return { type: m.type };
    if (m.type === "cast" && typeof m.prompt === "string") return { type: "cast", prompt: m.prompt };
    return null;
  } catch {
    return null;
  }
}
