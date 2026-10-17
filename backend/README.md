# Prompt Wizard Duels: backend

Cloudflare Workers + SQLite-backed Durable Objects + D1 + R2 + Workers AI.

| Doc | What |
|---|---|
| [CONTRACT.md](CONTRACT.md) | REST + WebSocket contract for the frontend. Start here. |
| [CHALLENGES.md](CHALLENGES.md) | Challenge set folder format and loader |
| [DECISIONS.md](DECISIONS.md) | Choices the brief left open |

```
src/
  index.ts                     API Worker (Hono): session, rate limit, routing, assets, admin
  auth.ts  config.ts  protocol.ts
  matchmaker/MatchmakerDO.ts   single global FIFO lobby (+ pure logic.ts)
  match/MatchDO.ts             one per match: phases, WebSocket hibernation, alarms (+ pure rules.ts)
  challenges/                  set schema/validation, D1 + R2 repo
  providers/imagegen/          WorkersAiFluxProvider (default), OpenArtProvider, StubImageGenProvider
  judging/objective/           deterministic agent: dHash, histogram χ², SSIM, keyword overlap
  judging/whiskers/            LLM judge pipeline + providers (Anthropic via AI Gateway, Workers AI vision, stub)
config/
  objective-rubric.json        objective weights/maxes (sum 50) — tune here
  teachers/*.json              magic teachers (rubric sums 50)
migrations/0001_init.sql       D1 schema
scripts/                       make-stub-set.ts, load-set.ts
test/                          vitest units + play-match.ts harness
```

## Setup

Needs Node 20+ (tested on Node 24).

```bash
cd backend
npm install
```

### Local only, no Cloudflare account needed

```bash
npm run db:migrate:local                   # create the local D1 tables
npm run dev:stub                           # wrangler dev --local, stub providers, ACCESS_CODE=letmein, ADMIN_TOKEN=dev-admin
# in another terminal:
npm run load-set -- ../challenges/stub-001 # images → local R2, rows → local D1, manifest.json
npm run harness                            # two scripted wizards play a full 3-round match
```

`npm run dev:stub:fast` uses 8 s casting and a 5 s disconnect grace. Pair it with `npm run harness:edge` (void, forfeit, disconnect forfeit).

### Real Cloudflare resources

```bash
npx wrangler login
npx wrangler d1 create prompt-wizard-duels       # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create prompt-wizard-duels
npm run db:migrate:remote
npx wrangler secret put ACCESS_CODE
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY        # optional; without it the judge uses Workers AI
npm run deploy
ADMIN_TOKEN=... npm run load-set -- ../challenges --all --api https://prompt-wizard-duels.<you>.workers.dev
```

AI Gateway (recommended for the Anthropic judge: logging, caching, spend limits): create a gateway in the dashboard (AI → AI Gateway), then set `AI_GATEWAY_URL` in `wrangler.jsonc` vars to `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>`. If it's empty, the judge calls `api.anthropic.com` directly.

### Run dev with real providers

```bash
cp .dev.vars.example .dev.vars   # fill in ACCESS_CODE, keys
npx wrangler login               # Workers AI always runs remotely, even in dev (and bills your account)
npm run dev
```

## Tests

```bash
npm test             # vitest: win rules (3 & 5 rounds, ties, draws), objective parts on known images,
                     #         teacher validation + judge retry/fallback, matchmaker pairing/expiry
npm run typecheck    # worker + scripts
npm run harness      # needs `npm run dev:stub` running and the stub set loaded
```

## Environment

Full table with defaults: [CONTRACT.md §7](CONTRACT.md#7-config-table). Non-secrets are `vars` in `wrangler.jsonc`. Secrets go through `wrangler secret put` (or `.dev.vars` locally).

| Var | Default |
|---|---|
| `ACCESS_CODE` (secret) | required |
| `SESSION_SECRET`, `ADMIN_TOKEN`, `ANTHROPIC_API_KEY`, `OPENART_API_KEY` (secrets) | optional |
| `ROUNDS_PER_MATCH` / `CAST_SECONDS` / `CAST_GRACE_SECONDS` | 3 / 60 / 3 |
| `QUEUE_TIMEOUT_SECONDS` / `DISCONNECT_GRACE_SECONDS` / `READY_TIMEOUT_SECONDS` / `VERDICT_SECONDS` | 60 / 30 / 15 / 12 |
| `MAX_PROMPT_CHARS` / `DAILY_DUEL_CAP` / `SESSION_TTL_HOURS` | 400 / 200 / 720 |
| `IMAGE_GEN_PROVIDER` / `IMAGE_GEN_MODEL` | `workers-ai` / `@cf/black-forest-labs/flux-2-klein-4b` |
| `JUDGE_PROVIDER` / `JUDGE_MODEL` / `JUDGE_VISION_MODEL` | `anthropic` / `claude-haiku-5-5` / `@cf/meta/llama-4-scout-17b-16e-instruct` |
| `TEACHER` | `professor-whiskers` |
| `AI_GATEWAY_URL`, `OPENART_BASE_URL`, `ASSET_BASE_URL` | empty, `https://api.openart.ai/v1`, empty |

## Swap a provider

- Image generation: set `IMAGE_GEN_PROVIDER` to `workers-ai`, `openart` or `stub`. Use `IMAGE_GEN_MODEL` for another Workers AI model.
- Judge: set `JUDGE_PROVIDER` to `anthropic`, `workers-ai` or `stub`. Use `JUDGE_MODEL` for another Claude model.
- Change them per deploy without editing files: `npx wrangler deploy --var JUDGE_PROVIDER:workers-ai`.
- A missing key falls back to Workers AI and logs one warning.
- New provider: implement `ImageGenProvider` (`src/providers/imagegen/types.ts`) or `JudgeProvider` (`src/judging/whiskers/types.ts`), then add a `case` in that folder's `index.ts`. The judge pipeline handles validation, retry and fallback, so a provider only returns parsed JSON.
- `OpenArtProvider` is written against a guessed REST shape. Every assumption is marked `TODO-verify` in `src/providers/imagegen/openArt.ts`.

## Add a teacher

1. Copy `config/teachers/template-teacher.json` to `config/teachers/<id>.json`. Write `name`, `systemPrompt`, `rubric` (maxes sum to 50) and `quoteStyle`, plus optional `cannedQuotes`.
2. Add one import line in `src/judging/whiskers/teachers.ts`.
3. Run `npm test`. It validates every registered teacher.
4. Set `TEACHER=<id>`. Matches store the teacher id at creation, so a running match keeps its teacher.

## Tune the objective agent

Edit `config/objective-rubric.json`. Each part maps a similarity in [0, 1] to points: `score = max × clamp((sim − floor) / (ceiling − floor))`.

- Maxes must sum to 50 (`npm test` checks).
- Every scored round logs the raw similarities (`"message":"objective scored"`, field `raw`). Use those to calibrate floors and ceilings on real sets.

## Verify before launch (assumptions about the Cloudflare free plan)

These are **assumptions** made while building, not checked facts. Check each against current Cloudflare docs and your dashboard.

1. **CPU time is the main risk.** Assumption: free-plan Workers and Durable Objects get ~10 ms of CPU per invocation. Measured in Node, image work per round is roughly:
   - objective scoring: 35–65 ms for two 512 px images;
   - judge image prep: ~18 ms per image that must be downscaled;
   - FLUX input prep: ~80 ms for a 1024 px Before that must be downscaled.

   This all runs in the MatchDO `alarm()`, which likely exceeds a 10 ms limit. Mitigations, in order:
   - author set images at ≤ 512 px, so provider prep is skipped (it passes small images through untouched);
   - move to Workers Paid (30 s default CPU);
   - lower `imageSize` in the rubric.
2. **SQLite-backed Durable Objects are available on the free plan** (assumed yes). The classes use `new_sqlite_classes`.
3. **Durable Object free limits** (assumed ~100k requests/day and a limited daily duration, measured in GB-s). Hibernating WebSockets and alarms count. A 3-round match is a few dozen DO requests plus pings. Pings are auto-answered without waking the object.
4. **Workers free: 100k requests/day.** `/queue/status` polling at 1 req/s per waiting player counts toward this.
5. **Workers AI free allocation** (assumed ~10k neurons/day). Two FLUX.2 [klein] images per round, plus the Workers AI judge if used, may burn through it fast. Check per-image neuron cost. `DAILY_DUEL_CAP` (default 200/day) is the guard.
6. **FLUX.2 [klein] input contract**: multipart `input_image_0`, inputs < 512×512, output `{ image: base64 }`. Taken from docs and changelog; not yet run.
7. **Llama 4 Scout** accepts several images and `response_format: json_schema` (unverified; TODO-verify in `workersAiVision.ts`).
8. **D1 free limits** (assumed 5 GB storage, 5M row reads/day, 100k row writes/day). Each round writes ~20 `round_scores` rows.
9. **R2 free tier** (assumed 10 GB storage, 1M Class A / 10M Class B ops per month). Every result image is stored at `matches/<id>/…` and never deleted. Add an R2 lifecycle rule (e.g. expire `matches/` after 30 days).
10. **Rate Limiting binding** is available on the free plan, and `period` must be 10 or 60.
11. **Worker bundle size**: ~1.2 MB raw / 228 KB gzipped (measured by `wrangler deploy --dry-run`). Assumed limit: 3 MB gzipped on free.
12. **AI Gateway** is free, and Anthropic requests pass through it with your own key.
13. **Claude model id** `claude-haiku-5-5` and structured outputs (`output_config.format`) work through AI Gateway's Anthropic endpoint.

## What has and hasn't been exercised

Exercised, with `wrangler dev --local` and stub providers, no Cloudflare login:
- session issue and the access-code check;
- queue join, pairing and status;
- challenge list and manifest;
- `/assets` serving;
- admin upload and idempotent reload;
- MatchDO over hibernating WebSockets: a full 3-round match, a mid-round reconnect, void after one retry, forfeit at the deadline, and disconnect forfeit;
- D1 writes;
- PNG and JPEG decoding inside workerd (`POST /admin/decode`).

Not exercised:
- the Workers AI FLUX provider, the Workers AI vision judge, the Anthropic judge and the OpenArt adapter (they need a Cloudflare login, keys, or API docs);
- remote D1 and R2;
- deployed rate limits;
- real-world latency and CPU limits.
