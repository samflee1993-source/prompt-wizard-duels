# Prompt Wizard Duels — Backend Contract (v1)

This is the frontend handoff. If the code and this file disagree, this file is the spec and the code has a bug.

- Base URL: `https://<worker>.workers.dev` in production, `http://localhost:8787` under `wrangler dev`.
- All bodies are JSON (`Content-Type: application/json`) unless noted.
- All timestamps are **epoch milliseconds** (numbers). Durations are seconds.
- Player slots are `"A"` and `"B"`. You learn your own slot from `match_found.you`.
- CORS is open (`*`) for the beta, so Expo web can call the API from any origin.

---

## 1. Auth model

1. The client generates an anonymous **device id** once (UUID v4 recommended; 8–64 chars of `[A-Za-z0-9_-]`) and stores it forever (AsyncStorage / SecureStore / localStorage).
2. The user types the shared **access code** once. The client calls `POST /session`.
3. The response carries a **session token**. Send it on every REST call as `Authorization: Bearer <token>`.
4. WebSockets can't set headers in browsers, so the WS URL takes it as a query param: `/match/:id/ws?token=<token>`.
5. Tokens are stateless and signed. They last `SESSION_TTL_HOURS` (default 30 days). On a `401` with `code: "invalid_token"`, call `POST /session` again with the stored device id. The same device id gets the same identity and can reattach to its live match.

---

## 2. Error format (REST)

Every non-2xx response has this body:

```json
{ "error": { "code": "rate_limited", "message": "Slow down, wizard." } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `bad_request` | Malformed body or params |
| 401 | `bad_access_code` | `POST /session` with the wrong code |
| 401 | `invalid_token` | Missing, bad or expired token |
| 403 | `not_participant` | `GET /match/:id` or WS for a match you are not in |
| 404 | `not_found` | Unknown match, set or route |
| 429 | `rate_limited` | Per-device rate limit (default 60 requests / 60 s) |
| 429 | `daily_cap_reached` | `DAILY_DUEL_CAP` matches already started today (UTC) |
| 503 | `no_challenge_sets` | No loaded set has `ROUNDS_PER_MATCH` rounds |
| 500 | `internal` | Bug. Retry once, then show a friendly error |

---

## 3. REST endpoints

### `GET /health` (no auth)

```json
{
  "ok": true,
  "service": "prompt-wizard-duels",
  "version": "1.0.0",
  "time": 1760659200000,
  "providers": { "imageGen": "workers-ai", "judge": "anthropic", "teacher": "professor-whiskers" },
  "config": { "roundsPerMatch": 3, "castSeconds": 60, "queueTimeoutSeconds": 60, "disconnectGraceSeconds": 30 }
}
```

### `POST /session` (no auth)

Request:

```json
{ "accessCode": "open-sesame", "deviceId": "6f1c2a7e-0d7b-4a51-9a0e-1f6b2c3d4e5f", "displayName": "Merlin42" }
```

`displayName` is optional (1–24 chars). If you leave it out, you get `"Wizard-xxxx"` from the device id.

Response `200`:

```json
{
  "token": "v1.eyJkIjoiNmYxYzJh....sig",
  "deviceId": "6f1c2a7e-0d7b-4a51-9a0e-1f6b2c3d4e5f",
  "displayName": "Merlin42",
  "expiresAt": 1763251200000
}
```

### `POST /queue/join` (auth)

Joins the one global FIFO lobby. Body optional: `{}`.
Calling it while already waiting keeps your place in line. Calling it after a match was found starts a new wait (for "duel again").

Response `200`, either still waiting:

```json
{ "status": "waiting", "joinedAt": 1760659200000, "expiresAt": 1760659260000, "position": 1 }
```

or paired straight away:

```json
{
  "status": "matched",
  "matchId": "c0a8012e-5b6e-4f7e-9e65-7a8f1f0f3b10",
  "wsUrl": "wss://<worker>/match/c0a8012e-5b6e-4f7e-9e65-7a8f1f0f3b10/ws"
}
```

`wsUrl` doesn't include the token. Add `?token=...` yourself.

### `GET /queue/status` (auth)

**Poll every 1–2 s while waiting.** It returns the same shapes as join, plus:

```json
{ "status": "idle" }
{ "status": "expired", "joinedAt": 1760659200000, "expiresAt": 1760659260000 }
```

`expired` means nobody showed up within `QUEUE_TIMEOUT_SECONDS`. Show "No wizards around, try again" and offer a re-join.
A `matched` status stays readable for 10 minutes after pairing.

### `POST /queue/leave` (auth)

Response: `{ "status": "idle" }`. Safe to call at any time.

### `GET /match/:id` (auth, participants only)

A full snapshot for reconnect, cold start or deep link. The same object is embedded in `match_found.snapshot`.

```json
{
  "matchId": "c0a8012e-5b6e-4f7e-9e65-7a8f1f0f3b10",
  "you": "A",
  "phase": "casting",
  "round": 2,
  "roundsTotal": 3,
  "roundsToWin": 2,
  "set": { "id": "stub-001", "title": "Stub Set: Shapes in Peril" },
  "teacher": { "id": "professor-whiskers", "name": "Professor Whiskers" },
  "players": {
    "A": { "displayName": "Merlin42", "connected": true, "cast": false, "ready": false, "graceUntil": null },
    "B": { "displayName": "Morgana", "connected": false, "cast": true, "ready": false, "graceUntil": 1760659290000 }
  },
  "current": { "...": "the round_intro payload for the current round, or null in lobby" },
  "yourCast": null,
  "lastReveal": null,
  "history": [ { "...": "verdict payloads for finished rounds, oldest first" } ],
  "tally": { "A": 1, "B": 0, "ties": 0, "voids": 0 },
  "ended": null,
  "serverNow": 1760659262000
}
```

`phase` is one of `lobby | intro | casting | generating | judging | verdict | ended`. `ended` holds the `match_end` payload once the match is over.

### `GET /challenges?limit=20&cursor=<opaque>` (auth)

A paged list, newest first. `limit` runs 1–100 (default 20). Pass `nextCursor` back as `cursor` until it comes back `null`.

```json
{
  "items": [
    {
      "id": "stub-001",
      "title": "Stub Set: Shapes in Peril",
      "description": "Placeholder set so the pipeline runs end to end.",
      "difficulty": "easy",
      "tags": ["stub", "shapes"],
      "author": "pwd-team",
      "roundCount": 3,
      "thumbnailUrl": "https://<worker>/assets/sets/stub-001/r1/target.png",
      "createdAt": 1760659200000,
      "updatedAt": 1760659200000
    }
  ],
  "nextCursor": null
}
```

### `GET /challenges/:setId` (auth)

The full manifest for one set (see §6). All image URLs are absolute.

### `GET /assets/<key>` (no auth)

Streams an image from R2 (`image/png` or `image/jpeg`) with long cache headers. Every image URL the API returns points here, unless `ASSET_BASE_URL` points at a public R2 domain.

---

## 4. WebSocket `/match/:id/ws?token=<token>`

- Open it as soon as you have a `matchId`. Any non-participant is rejected with HTTP 403 before the upgrade.
- **Every server message** is a JSON text frame with this envelope:

```json
{ "type": "<event>", "matchId": "c0a8...", "seq": 17, "sentAt": 1760659262000, "...payload fields": "..." }
```

`seq` increases per match. On reconnect you get a fresh `match_found` with a full snapshot, so you never need to replay missed events. Just render the snapshot.

- If the same device opens a second socket, the older socket is closed with code `4000` (`"replaced"`).
- After `match_end` the server closes the socket with code `1000`.

### Phase flow (one round)

```
lobby ──(both connected+ready, or READY_TIMEOUT)──► intro ──► casting ──(both cast, or deadline)──►
generating ──► judging ──► verdict ──(both ready, or VERDICT_SECONDS)──► next round intro | ended
```

Events, in order, for a normal round:
`round_intro` → (`cast_received` to you, `opponent_status` about them) → `generating` → `reveal` → `verdict` → (after the last round, or once someone has `roundsToWin`) `match_end`.

### Client → server

| type | payload | when |
|---|---|---|
| `ready` | `{}` | In `lobby` ("I'm here, start") and in `verdict` ("next round"). Ignored elsewhere. |
| `cast` | `{ "prompt": string }` | During `casting`. 1..`MAX_PROMPT_CHARS` chars after trim. One cast per round. |
| `ping` | `{}` | Keepalive every ~20 s. Send exactly `{"type":"ping"}` so the server can answer without waking up. |

**Auto-cast rule, which the client must implement:** when your local countdown reaches `deadlineAt`, a non-empty prompt field must be sent as a `cast` right away. The server accepts casts until `deadlineAt + CAST_GRACE_SECONDS` (default 3 s) to absorb latency. After that, a player with no cast **forfeits the round**. An empty field sends nothing, and that is the forfeit.

JSON schemas (client → server):

```json
{ "$id": "ready", "type": "object", "required": ["type"], "properties": { "type": { "const": "ready" } } }
{ "$id": "cast", "type": "object", "required": ["type", "prompt"],
  "properties": { "type": { "const": "cast" }, "prompt": { "type": "string", "minLength": 1, "maxLength": 400 } } }
{ "$id": "ping", "type": "object", "required": ["type"], "properties": { "type": { "const": "ping" } } }
```

Examples:

```json
{ "type": "ready" }
{ "type": "cast", "prompt": "the same blue square but at sunset, warm orange light, long shadows" }
{ "type": "ping" }
```

### Server → client

The envelope fields (`type`, `matchId`, `seq`, `sentAt`) are left out of the schemas below. Every message has them.

#### `match_found`

The first message on every (re)connect.

```json
{ "type": "object",
  "required": ["you", "opponent", "roundsTotal", "roundsToWin", "config", "snapshot"],
  "properties": {
    "you": { "enum": ["A", "B"] },
    "opponent": { "type": "object", "properties": { "displayName": { "type": "string" } } },
    "roundsTotal": { "type": "integer" }, "roundsToWin": { "type": "integer" },
    "config": { "type": "object", "properties": {
      "castSeconds": { "type": "integer" }, "castGraceSeconds": { "type": "integer" },
      "disconnectGraceSeconds": { "type": "integer" }, "verdictSeconds": { "type": "integer" },
      "maxPromptChars": { "type": "integer" } } },
    "snapshot": { "$ref": "GET /match/:id response" } } }
```

```json
{ "type": "match_found", "matchId": "c0a8...", "seq": 1, "sentAt": 1760659201000,
  "you": "A", "opponent": { "displayName": "Morgana" }, "roundsTotal": 3, "roundsToWin": 2,
  "config": { "castSeconds": 60, "castGraceSeconds": 3, "disconnectGraceSeconds": 30, "verdictSeconds": 12, "maxPromptChars": 400 },
  "snapshot": { "matchId": "c0a8...", "you": "A", "phase": "lobby", "round": 0, "...": "..." } }
```

#### `round_intro`

The round starts. Show Before and Target and start the countdown to `deadlineAt`.

```json
{ "type": "object", "required": ["round", "roundsTotal", "before", "target", "clue", "tip", "deadlineAt", "serverNow"],
  "properties": {
    "round": { "type": "integer", "minimum": 1 }, "roundsTotal": { "type": "integer" },
    "before": { "type": "string", "format": "uri" }, "target": { "type": "string", "format": "uri" },
    "clue": { "type": "string" }, "tip": { "type": "string" },
    "deadlineAt": { "type": "integer" }, "serverNow": { "type": "integer" } } }
```

```json
{ "type": "round_intro", "matchId": "c0a8...", "seq": 4, "sentAt": 1760659205000,
  "round": 1, "roundsTotal": 3,
  "before": "https://<worker>/assets/sets/stub-001/r1/before.png",
  "target": "https://<worker>/assets/sets/stub-001/r1/target.png",
  "clue": "The sky grew tired of blue and borrowed the sun's last coat.",
  "tip": "Name the change, then name what must stay the same.",
  "deadlineAt": 1760659265000, "serverNow": 1760659205000 }
```

Clock skew: compute `offset = serverNow - Date.now()` and count down to `deadlineAt - offset`.

#### `cast_received` (to the caster only)

```json
{ "type": "object", "required": ["round", "prompt", "castAt", "late"],
  "properties": { "round": { "type": "integer" }, "prompt": { "type": "string" },
    "castAt": { "type": "integer" }, "late": { "type": "boolean", "description": "arrived inside the grace window" } } }
```

```json
{ "type": "cast_received", "matchId": "c0a8...", "seq": 6, "sentAt": 1760659230000,
  "round": 1, "prompt": "turn the sky orange like sunset", "castAt": 1760659230000, "late": false }
```

#### `opponent_status`

Sent whenever the opponent connects, reconnects, casts or readies up. It never contains their prompt before `reveal`.

```json
{ "type": "object", "required": ["connected", "cast", "ready"],
  "properties": { "connected": { "type": "boolean" }, "cast": { "type": "boolean" },
    "ready": { "type": "boolean" }, "graceUntil": { "type": ["integer", "null"] } } }
```

```json
{ "type": "opponent_status", "matchId": "c0a8...", "seq": 7, "sentAt": 1760659231000,
  "connected": true, "cast": true, "ready": false, "graceUntil": null }
```

#### `generating`

Casting closed and images are being made. Expect 3–30 s with real providers.

```json
{ "type": "object", "required": ["round", "players", "forfeits"],
  "properties": { "round": { "type": "integer" },
    "players": { "type": "array", "items": { "enum": ["A", "B"] }, "description": "slots being generated" },
    "forfeits": { "type": "array", "items": { "enum": ["A", "B"] } } } }
```

```json
{ "type": "generating", "matchId": "c0a8...", "seq": 8, "sentAt": 1760659232000,
  "round": 1, "players": ["A", "B"], "forfeits": [] }
```

#### `reveal`

Both results are shown side by side. Judging starts right after.

```json
{ "type": "object", "required": ["round", "results"],
  "properties": { "round": { "type": "integer" },
    "results": { "type": "object", "properties": {
      "A": { "$ref": "#/RevealResult" }, "B": { "$ref": "#/RevealResult" } } } },
  "RevealResult": { "type": "object", "required": ["status", "prompt", "imageUrl"],
    "properties": {
      "status": { "enum": ["ok", "forfeit", "failed"] },
      "prompt": { "type": ["string", "null"] },
      "imageUrl": { "type": ["string", "null"], "format": "uri" } } } }
```

```json
{ "type": "reveal", "matchId": "c0a8...", "seq": 9, "sentAt": 1760659240000,
  "round": 1,
  "results": {
    "A": { "status": "ok", "prompt": "turn the sky orange like sunset", "imageUrl": "https://<worker>/assets/matches/c0a8.../r1/A.png" },
    "B": { "status": "ok", "prompt": "sunset colors", "imageUrl": "https://<worker>/assets/matches/c0a8.../r1/B.png" } } }
```

If generation fails twice for anyone, `reveal` is skipped and `verdict` arrives with `outcome: "void"`.

#### `verdict`

```json
{ "type": "object",
  "required": ["round", "outcome", "scores", "roundWinner", "quotes", "originalPrompt", "lesson", "tally", "nextRoundAt"],
  "properties": {
    "round": { "type": "integer" },
    "outcome": { "enum": ["scored", "forfeit", "no_contest", "void"],
      "description": "scored = both judged; forfeit = one player forfeited; no_contest = both forfeited; void = generation failed" },
    "scores": { "type": "object", "properties": {
      "A": { "oneOf": [{ "$ref": "#/PlayerScore" }, { "type": "null" }] },
      "B": { "oneOf": [{ "$ref": "#/PlayerScore" }, { "type": "null" }] } } },
    "roundWinner": { "enum": ["A", "B", null] },
    "quotes": { "type": "object", "properties": { "A": { "type": ["string", "null"] }, "B": { "type": ["string", "null"] } } },
    "originalPrompt": { "type": "string" },
    "lesson": { "type": "string", "description": "one line about why the original prompt worked" },
    "tally": { "$ref": "#/Tally" },
    "nextRoundAt": { "type": ["integer", "null"], "description": "auto-advance time; null if the match is over" },
    "teacher": { "type": "object", "properties": { "id": { "type": "string" }, "name": { "type": "string" } } } } }
```

```json
{ "type": "verdict", "matchId": "c0a8...", "seq": 10, "sentAt": 1760659248000,
  "round": 1, "outcome": "scored",
  "scores": {
    "A": {
      "objective": { "total": 38.4, "parts": {
        "structure": { "score": 11.2, "max": 12 }, "color": { "score": 9.6, "max": 12 },
        "detail": { "score": 10.1, "max": 14 }, "keywords": { "score": 7.5, "max": 12 } } },
      "whiskers": { "total": 41, "parts": {
        "intent": { "score": 13, "max": 15 }, "fidelity": { "score": 12, "max": 15 },
        "specificity": { "score": 8, "max": 10 }, "craft": { "score": 8, "max": 10 } },
        "quote": "You asked for sunset and the model delivered sunset. I am as surprised as you are." },
      "total": 79.4 },
    "B": {
      "objective": { "total": 30.2, "parts": { "structure": { "score": 10.9, "max": 12 }, "color": { "score": 6.1, "max": 12 }, "detail": { "score": 9.8, "max": 14 }, "keywords": { "score": 3.4, "max": 12 } } },
      "whiskers": { "total": 33, "parts": { "intent": { "score": 11, "max": 15 }, "fidelity": { "score": 9, "max": 15 }, "specificity": { "score": 6, "max": 10 }, "craft": { "score": 7, "max": 10 } },
        "quote": "Two words. Bold. The GPU appreciated the light workload; I appreciated nothing." },
      "total": 63.2 } },
  "roundWinner": "A",
  "quotes": { "A": "You asked for sunset and the model delivered sunset. I am as surprised as you are.",
              "B": "Two words. Bold. The GPU appreciated the light workload; I appreciated nothing." },
  "originalPrompt": "same scene, sky shifted to a warm orange sunset gradient, keep the square untouched",
  "lesson": "Saying what must NOT change is half the spell.",
  "tally": { "A": 1, "B": 0, "ties": 0, "voids": 0 },
  "nextRoundAt": 1760659260000,
  "teacher": { "id": "professor-whiskers", "name": "Professor Whiskers" } }
```

#### `match_end`

```json
{ "type": "object", "required": ["tally", "winner", "reason", "totals"],
  "properties": {
    "tally": { "$ref": "#/Tally" },
    "winner": { "enum": ["A", "B", null], "description": "null = draw or abandoned" },
    "reason": { "enum": ["majority", "score_tiebreak", "draw", "forfeit_disconnect", "abandoned"] },
    "totals": { "type": "object", "properties": { "A": { "type": "number" }, "B": { "type": "number" } },
      "description": "sum of per-round totals (0-100 each)" } } }
```

```json
{ "type": "match_end", "matchId": "c0a8...", "seq": 31, "sentAt": 1760659330000,
  "tally": { "A": 2, "B": 1, "ties": 0, "voids": 0 }, "winner": "A", "reason": "majority",
  "totals": { "A": 221.7, "B": 190.3 } }
```

#### `opponent_disconnected`

```json
{ "type": "object", "required": ["graceUntil"], "properties": { "graceUntil": { "type": "integer" } } }
```

```json
{ "type": "opponent_disconnected", "matchId": "c0a8...", "seq": 12, "sentAt": 1760659250000, "graceUntil": 1760659280000 }
```

If they come back, you get `opponent_status { connected: true }`. If they don't, you get `match_end { reason: "forfeit_disconnect", winner: <you> }`.

#### `pong`

```json
{ "type": "pong" }
```

The auto-response has no envelope fields.

#### `error`

The socket stays open. Show a toast or ignore it.

```json
{ "type": "object", "required": ["code", "message"],
  "properties": { "code": { "enum": ["bad_message", "wrong_phase", "already_cast", "empty_prompt", "prompt_too_long", "match_over"] },
    "message": { "type": "string" } } }
```

```json
{ "type": "error", "matchId": "c0a8...", "seq": 13, "sentAt": 1760659251000, "code": "already_cast", "message": "One spell per round." }
```

### Round and match rules (server-enforced)

- Round winner: the higher `total` wins. Equal totals → `roundWinner: null` (tie, no point). A forfeiter gets `null` scores and the other player takes the round, even though their result is still judged and shown. Both forfeit → `no_contest`. Generation failed after one retry → `void`, no points.
- Voided, no-contest and tied rounds still count toward `roundsTotal`. They are not replayed.
- The first player to `roundsToWin = ceil(roundsTotal / 2)` round wins takes the match. That ends it at once (`reason: "majority"`).
- After all rounds with nobody at `roundsToWin` (round wins no longer matter at this point): higher `totals` wins (`score_tiebreak`). If totals are equal → `winner: null`, `reason: "draw"`.
- Disconnect: `DISCONNECT_GRACE_SECONDS` to reattach. Past that the opponent wins (`forfeit_disconnect`). If both are gone past grace → `abandoned`, `winner: null`. A player who never connects after pairing is treated as disconnected from the moment of pairing.

---

## 5. Scoring schema (per player per round)

```json
{ "$id": "PlayerScore", "type": "object", "required": ["objective", "whiskers", "total"],
  "properties": {
    "objective": { "type": "object", "required": ["total", "parts"], "properties": {
      "total": { "type": "number", "minimum": 0, "maximum": 50 },
      "parts": { "type": "object", "additionalProperties": {
        "type": "object", "required": ["score", "max"],
        "properties": { "score": { "type": "number" }, "max": { "type": "number" } } } } } },
    "whiskers": { "type": "object", "required": ["total", "parts", "quote"], "properties": {
      "total": { "type": "number", "minimum": 0, "maximum": 50 },
      "parts": { "type": "object", "additionalProperties": {
        "type": "object", "required": ["score", "max"],
        "properties": { "score": { "type": "number" }, "max": { "type": "number" } } } },
      "quote": { "type": "string" },
      "fallback": { "type": "boolean", "description": "true when the LLM judge failed and canned 25/50 scores were used" } } },
    "total": { "type": "number", "minimum": 0, "maximum": 100 } } }
```

- `total = objective.total + whiskers.total`, rounded to 1 decimal.
- Part keys come from config (`config/objective-rubric.json`, `config/teachers/<teacher>.json`). **Render parts dynamically.** Never hard-code the keys. Each part also carries an optional `label` string (e.g. `"Structure match"`) for display: `{ "score": 11.2, "max": 12, "label": "Structure match" }`.
- Current objective parts: `structure` (dHash), `color` (histogram), `detail` (SSIM), `keywords` (prompt vs. original prompt).
- Current Professor Whiskers parts: `intent`, `fidelity`, `specificity`, `craft`.

```json
{ "$id": "Tally", "type": "object", "required": ["A", "B", "ties", "voids"],
  "properties": { "A": { "type": "integer" }, "B": { "type": "integer" },
    "ties": { "type": "integer", "description": "tied rounds" },
    "voids": { "type": "integer", "description": "void + no_contest rounds" } } }
```

---

## 6. Challenge set manifest schema

Stored at R2 `sets/{setId}/manifest.json`. Served (with absolute URLs) by `GET /challenges/:setId`.

```json
{ "$id": "ChallengeManifest", "type": "object",
  "required": ["schemaVersion", "id", "title", "roundCount", "rounds", "updatedAt"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,62}$" },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "difficulty": { "enum": ["easy", "medium", "hard"] },
    "tags": { "type": "array", "items": { "type": "string" } },
    "author": { "type": "string" },
    "roundCount": { "type": "integer", "minimum": 1 },
    "createdAt": { "type": "integer" }, "updatedAt": { "type": "integer" },
    "rounds": { "type": "array", "items": {
      "type": "object",
      "required": ["index", "before", "target", "originalPrompt", "modelId", "modelParams", "clue", "tip"],
      "properties": {
        "index": { "type": "integer", "minimum": 1 },
        "before": { "type": "object", "required": ["key", "url"], "properties": {
          "key": { "type": "string", "description": "R2 key, e.g. sets/stub-001/r1/before.png" },
          "url": { "type": "string", "description": "absolute in API responses; '/assets/<key>' in R2" },
          "width": { "type": "integer" }, "height": { "type": "integer" } } },
        "target": { "$ref": "#/properties/rounds/items/properties/before" },
        "originalPrompt": { "type": "string" },
        "modelId": { "type": "string", "description": "model that produced target from before" },
        "modelParams": { "type": "object", "description": "free-form: seed, steps, guidance, strength..." },
        "clue": { "type": "string", "description": "riddle-style hint shown to players" },
        "tip": { "type": "string", "description": "prompting tip shown to players" } } } } } }
```

Example:

```json
{
  "schemaVersion": 1,
  "id": "stub-001",
  "title": "Stub Set: Shapes in Peril",
  "description": "Placeholder set so the pipeline runs end to end.",
  "difficulty": "easy",
  "tags": ["stub", "shapes"],
  "author": "pwd-team",
  "roundCount": 3,
  "createdAt": 1760659200000,
  "updatedAt": 1760659200000,
  "rounds": [
    {
      "index": 1,
      "before": { "key": "sets/stub-001/r1/before.png", "url": "https://<worker>/assets/sets/stub-001/r1/before.png", "width": 128, "height": 128 },
      "target": { "key": "sets/stub-001/r1/target.png", "url": "https://<worker>/assets/sets/stub-001/r1/target.png", "width": 128, "height": 128 },
      "originalPrompt": "same composition, background turned to a warm orange sunset, keep the yellow circle",
      "modelId": "stub/solid-shapes",
      "modelParams": { "seed": 1 },
      "clue": "The sky grew tired of blue and borrowed the sun's last coat.",
      "tip": "Name the change, then name what must stay the same."
    }
  ]
}
```

Note for the frontend: the manifest includes `originalPrompt`, so a curious player could peek at the answers. That's accepted for the friends-and-family beta. During a match the server only sends `originalPrompt` in `verdict`.

---

## 7. Config table

Every tunable. Non-secrets live in `wrangler.jsonc` `vars`. Secrets are set with `wrangler secret put` (or `.dev.vars` locally).

| Env var | Default | Secret | Meaning |
|---|---|---|---|
| `ACCESS_CODE` | — (required) | yes | Shared beta access code for `POST /session` |
| `SESSION_SECRET` | falls back to `ACCESS_CODE` | yes | HMAC key for session tokens. Set it so that rotating the access code doesn't log everyone out |
| `ADMIN_TOKEN` | unset (admin API disabled) | yes | Bearer token for `/admin/*`, used by `scripts/load-set.ts` |
| `ROUNDS_PER_MATCH` | `3` | no | Rounds per match. `roundsToWin = ceil(n/2)` |
| `CAST_SECONDS` | `60` | no | Writing time per round |
| `CAST_GRACE_SECONDS` | `3` | no | Late-cast window after the deadline (latency allowance for auto-cast) |
| `QUEUE_TIMEOUT_SECONDS` | `60` | no | Lobby wait before `expired` |
| `DISCONNECT_GRACE_SECONDS` | `30` | no | Time to reattach before forfeit |
| `READY_TIMEOUT_SECONDS` | `15` | no | Lobby auto-start after both connect, even if nobody sent `ready` |
| `VERDICT_SECONDS` | `12` | no | Verdict screen auto-advance (skipped early when both `ready`) |
| `MAX_PROMPT_CHARS` | `400` | no | Max cast length |
| `DAILY_DUEL_CAP` | `200` | no | Max matches started per UTC day, across all players. `0` = unlimited |
| `SESSION_TTL_HOURS` | `720` | no | Session token lifetime |
| `IMAGE_GEN_PROVIDER` | `workers-ai` | no | `workers-ai` \| `openart` \| `stub` |
| `IMAGE_GEN_MODEL` | `@cf/black-forest-labs/flux-2-klein-4b` | no | Workers AI model for `workers-ai` |
| `JUDGE_PROVIDER` | `anthropic` | no | `anthropic` \| `workers-ai` \| `stub` |
| `JUDGE_MODEL` | `claude-haiku-5-5` | no | Anthropic model id for `anthropic` |
| `JUDGE_VISION_MODEL` | `@cf/meta/llama-4-scout-17b-16e-instruct` | no | Workers AI model for `workers-ai` judge |
| `TEACHER` | `professor-whiskers` | no | Teacher config id (`config/teachers/<id>.json`) |
| `AI_GATEWAY_URL` | unset | no | e.g. `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`. The Anthropic provider uses `<AI_GATEWAY_URL>/anthropic`. Unset = direct `api.anthropic.com` |
| `ANTHROPIC_API_KEY` | unset | yes | Missing → judge falls back to `workers-ai` (logged once) |
| `OPENART_API_KEY` | unset | yes | Missing → `openart` falls back to `workers-ai` (logged once) |
| `OPENART_BASE_URL` | `https://api.openart.ai/v1` | no | OpenArt API base (TODO-verify) |
| `ASSET_BASE_URL` | `<request origin>/assets` | no | Base for image URLs. Set to a public R2 custom domain to bypass the Worker |
| Rate limiter binding `RATE_LIMITER` | 60 req / 60 s per device | no | Set in `wrangler.jsonc` `ratelimits` |
