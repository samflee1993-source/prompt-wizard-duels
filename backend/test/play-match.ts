// End-to-end harness: two scripted wizards play a full match against a running `wrangler dev`.
//
//   npm run dev:stub          # terminal 1 (stub providers, ACCESS_CODE=letmein, ADMIN_TOKEN=dev-admin)
//   npm run load-set -- ../challenges/stub-001
//   npm run harness           # terminal 2
//
// Env: PWD_API (default http://localhost:8787), ACCESS_CODE (default letmein).
// Default scenario: A wins round 1 and B wins round 2, so round 3 decides; the second wizard drops
// its socket mid-round 1 and reattaches to exercise reconnect. Exits non-zero on any failed check.
//
// --edge scenario (start the server with `npm run dev:stub:fast`: 8 s casting, 5 s disconnect grace):
//   round 1: A's generation fails twice → void; round 2: B casts nothing → forfeit, A wins the round;
//   round 3: B disconnects for good → match_end forfeit_disconnect, A wins.
import type { MatchEndPayload, ServerMessage, Slot, VerdictPayload } from "../src/protocol.ts";

const API = (process.env.PWD_API ?? "http://localhost:8787").replace(/\/+$/, "");
const ACCESS_CODE = process.env.ACCESS_CODE ?? "letmein";
const TIMEOUT_MS = Number(process.env.HARNESS_TIMEOUT_MS ?? 240_000);

// Canned spells per round: [strong, weak]. Strong ones echo the stub set's original prompts.
const SPELLS: Array<{ strong: string; weak: string }> = [
  { strong: "same composition, warm orange sunset background, keep the yellow circle exactly as it is", weak: "make it nice" },
  { strong: "replace the red square with a red triangle pointing up, same size, keep the green background", weak: "shapes" },
  { strong: "night version: dark navy sky with small stars, the black circle becomes a glowing pale moon", weak: "dark" },
];
type Action = "strong" | "weak" | "fail" | "silent" | "vanish";
const EDGE = process.argv.includes("--edge");
const PLAN: Record<Slot, Action[]> = EDGE
  ? { A: ["fail", "strong", "strong"], B: ["strong", "silent", "vanish"] }
  : { A: ["strong", "weak", "strong"], B: ["weak", "strong", "weak"] };

const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  if (!ok) failures.push(msg);
  console.log(`${ok ? "  ✓" : "  ✗"} ${msg}`);
};

async function http<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

interface Wizard {
  name: string;
  deviceId: string;
  token: string;
  slot?: Slot;
  matchId?: string;
  verdicts: VerdictPayload[];
  end?: MatchEndPayload;
  reconnected: boolean;
  vanished?: boolean;
  events: string[];
}

async function makeWizard(name: string): Promise<Wizard> {
  const deviceId = `harness-${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
  const s = await http<{ token: string }>("POST", "/session", undefined, { accessCode: ACCESS_CODE, deviceId, displayName: name });
  return { name, deviceId, token: s.token, verdicts: [], reconnected: false, events: [] };
}

async function waitForMatch(w: Wizard): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const st = await http<{ status: string; matchId?: string }>("GET", "/queue/status", w.token);
    if (st.status === "matched" && st.matchId) return st.matchId;
    if (st.status !== "waiting") throw new Error(`${w.name}: unexpected queue status ${JSON.stringify(st)}`);
    if (Date.now() > deadline) throw new Error(`${w.name}: no match within 30s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function play(w: Wizard, opts: { dropOnce: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    const wsUrl = `${API.replace(/^http/, "ws")}/match/${w.matchId}/ws?token=${encodeURIComponent(w.token)}`;
    let dropped = false;
    const connect = () => {
      const ws = new WebSocket(wsUrl);
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as ServerMessage;
        w.events.push(m.type);
        switch (m.type) {
          case "match_found": {
            const mf = m as ServerMessage<"match_found">;
            w.slot = mf.you;
            console.log(`[${w.name}] match_found: I am ${mf.you} vs ${mf.opponent.displayName} (phase ${mf.snapshot.phase}, round ${mf.snapshot.round})`);
            if (mf.snapshot.phase === "lobby") ws.send(JSON.stringify({ type: "ready" }));
            break;
          }
          case "round_intro": {
            const ri = m as ServerMessage<"round_intro">;
            if (opts.dropOnce && !dropped && ri.round === 1) {
              dropped = true;
              console.log(`[${w.name}] dropping socket mid-round to test reattach`);
              ws.close();
              setTimeout(() => {
                w.reconnected = true;
                connect();
              }, 800);
              return;
            }
            const kind = PLAN[w.slot!][ri.round - 1];
            if (kind === "vanish") {
              console.log(`[${w.name}] round ${ri.round}: disconnecting for good`);
              w.vanished = true;
              ws.close();
              return resolve();
            }
            if (kind === "silent") {
              console.log(`[${w.name}] round ${ri.round}: leaving the scroll empty (forfeit)`);
              break;
            }
            const prompt = kind === "fail" ? "STUB_FAIL please" : SPELLS[ri.round - 1][kind];
            console.log(`[${w.name}] round ${ri.round}: clue "${ri.clue}" → casting (${kind})`);
            setTimeout(() => ws.send(JSON.stringify({ type: "cast", prompt })), 300 + Math.random() * 500);
            break;
          }
          case "cast_received":
            break;
          case "verdict": {
            const v = m as ServerMessage<"verdict">;
            w.verdicts.push(v);
            if (w.slot === "A") printVerdict(v);
            ws.send(JSON.stringify({ type: "ready" }));
            break;
          }
          case "match_end": {
            w.end = m as ServerMessage<"match_end">;
            break;
          }
          case "error":
            console.log(`[${w.name}] server error: ${JSON.stringify(m)}`);
            break;
          default:
            break;
        }
      };
      ws.onclose = (ev) => {
        if (w.end || w.vanished) return resolve();
        // The deliberate drop reconnects via the setTimeout above; any other close is a failure.
        if (dropped && !w.reconnected) return;
        reject(new Error(`${w.name}: socket closed before match_end (code ${ev.code} ${ev.reason})`));
      };
      ws.onerror = (e) => {
        if (!w.end) reject(new Error(`${w.name}: websocket error ${String((e as ErrorEvent).message ?? e)}`));
      };
    };
    connect();
  });
}

function printVerdict(v: VerdictPayload) {
  console.log(`\n=== Round ${v.round} verdict (${v.outcome}) — winner: ${v.roundWinner ?? "none"} ===`);
  for (const sl of ["A", "B"] as Slot[]) {
    const sc = v.scores[sl];
    if (!sc) {
      console.log(`  ${sl}: no score — "${v.quotes[sl]}"`);
      continue;
    }
    const parts = (p: Record<string, { score: number; max: number }>) => Object.entries(p).map(([k, x]) => `${k} ${x.score}/${x.max}`).join(", ");
    console.log(`  ${sl}: total ${sc.total}/100 = objective ${sc.objective.total}/50 [${parts(sc.objective.parts)}] + whiskers ${sc.whiskers.total}/50 [${parts(sc.whiskers.parts)}]`);
    console.log(`     Whiskers: "${sc.whiskers.quote}"`);
  }
  console.log(`  original prompt: "${v.originalPrompt}"`);
  console.log(`  lesson: ${v.lesson}`);
  console.log(`  tally: A ${v.tally.A} – B ${v.tally.B} (ties ${v.tally.ties}, voids ${v.tally.voids})\n`);
}

async function main() {
  console.log(`harness → ${API}`);
  const health = await http<{ providers: { imageGen: string; judge: string } }>("GET", "/health");
  console.log(`providers: image=${health.providers.imageGen} judge=${health.providers.judge}`);

  const sets = await http<{ items: Array<{ id: string; roundCount: number }> }>("GET", "/challenges?limit=5", (await makeWizard("Lister")).token);
  check(sets.items.length > 0, `challenge list has sets (${sets.items.map((s) => s.id).join(", ")})`);

  const merlin = await makeWizard("Merlin");
  const morgana = await makeWizard("Morgana");
  const j1 = await http<{ status: string }>("POST", "/queue/join", merlin.token, {});
  check(j1.status === "waiting", `first wizard waits in the lobby (got ${j1.status})`);
  const j2 = await http<{ status: string; matchId?: string }>("POST", "/queue/join", morgana.token, {});
  check(j2.status === "matched", `second wizard is paired immediately (got ${j2.status})`);

  merlin.matchId = await waitForMatch(merlin);
  morgana.matchId = await waitForMatch(morgana);
  check(merlin.matchId === morgana.matchId, `both see the same matchId ${merlin.matchId}`);

  const timer = setTimeout(() => {
    console.error(`timed out after ${TIMEOUT_MS} ms; events A=${merlin.events.join(",")} B=${morgana.events.join(",")}`);
    process.exit(1);
  }, TIMEOUT_MS);
  await Promise.all([play(merlin, { dropOnce: false }), play(morgana, { dropOnce: !EDGE })]);
  clearTimeout(timer);

  const [a, b] = merlin.slot === "A" ? [merlin, morgana] : [morgana, merlin];
  if (EDGE) return edgeChecks(a, b);
  const end = merlin.end!;
  console.log(`=== MATCH END: winner ${end.winner ?? "none (draw)"} by ${end.reason}; tally A ${end.tally.A} – B ${end.tally.B}; totals A ${end.totals.A} / B ${end.totals.B} ===\n`);

  const snapA = await http<{ phase: string; history: unknown[]; ended: MatchEndPayload | null }>("GET", `/match/${merlin.matchId}`, merlin.token);
  const verdicts = merlin.verdicts;
  check(verdicts.length === 3, `three verdicts received (got ${verdicts.length})`);
  check(morgana.verdicts.length === verdicts.length, "both wizards received every verdict");
  check(morgana.reconnected && morgana.events.filter((e) => e === "match_found").length >= 2, "second wizard reattached after dropping its socket mid-round");
  check(verdicts.every((v) => v.outcome === "scored" && v.scores.A && v.scores.B), "every round was scored for both players");
  check(
    verdicts.every((v) => ["A", "B"].every((s) => {
      const sc = v.scores[s as Slot]!;
      return sc.objective.total <= 50 && sc.whiskers.total <= 50 && Math.abs(sc.total - (sc.objective.total + sc.whiskers.total)) < 0.11;
    })),
    "scores: objective ≤ 50, whiskers ≤ 50, total = sum",
  );
  check(verdicts.every((v) => !!v.originalPrompt && !!v.lesson), "verdicts carry originalPrompt and lesson");
  check(!!end && end.tally.A + end.tally.B + end.tally.ties + end.tally.voids === verdicts.length, "tally adds up to rounds played");
  check(end.winner !== null ? end.tally[end.winner] >= end.tally[end.winner === "A" ? "B" : "A"] : true, "winner is consistent with the tally");
  check(snapA.phase === "ended" && snapA.ended?.winner === end.winner && snapA.history.length === verdicts.length, "GET /match/:id snapshot agrees (phase ended)");

  const forbidden = await fetch(`${API}/match/${merlin.matchId}`, { headers: { authorization: `Bearer ${(await makeWizard("Stranger")).token}` } });
  check(forbidden.status === 403, `non-participant gets 403 on the snapshot (got ${forbidden.status})`);

  if (failures.length) {
    console.error(`\nFAILED (${failures.length}):\n - ${failures.join("\n - ")}`);
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED");
  process.exit(0);
}

async function edgeChecks(a: Wizard, _b: Wizard) {
  const end = a.end!;
  const v = a.verdicts;
  console.log(`=== MATCH END: winner ${end.winner} by ${end.reason}; tally A ${end.tally.A} – B ${end.tally.B} ===`);
  check(v[0]?.outcome === "void" && v[0].roundWinner === null && !v[0].scores.A && !v[0].scores.B, "round 1: generation failure after one retry voids the round");
  check(v[1]?.outcome === "forfeit" && v[1].roundWinner === "A" && !v[1].scores.B && !!v[1].scores.A, "round 2: empty scroll at the deadline forfeits the round");
  check(!!v[1]?.quotes.B, "round 2: forfeiter still gets a (canned) Whiskers line");
  check(end.reason === "forfeit_disconnect" && end.winner === "A", "round 3: disconnect past the grace period forfeits the match");
  check(end.tally.voids === 1 && end.tally.A === 1, "tally: 1 void, A 1 round");
  const snap = await http<{ phase: string; players: { B: { connected: boolean } } }>("GET", `/match/${a.matchId}`, a.token);
  check(snap.phase === "ended" && snap.players.B.connected === false, "snapshot shows ended match with B disconnected");
  if (failures.length) {
    console.error(`FAILED (${failures.length}):`, failures);
    process.exit(1);
  }
  console.log("ALL EDGE CHECKS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
