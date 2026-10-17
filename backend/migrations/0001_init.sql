-- Prompt Wizard Duels v1 schema.

-- Challenge library ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS challenge_sets (
  id            TEXT PRIMARY KEY,                 -- e.g. 'stub-001'
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  difficulty    TEXT NOT NULL DEFAULT 'medium',   -- easy | medium | hard
  tags          TEXT NOT NULL DEFAULT '[]',       -- JSON array of strings
  author        TEXT NOT NULL DEFAULT '',
  round_count   INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',   -- active | hidden
  manifest_key  TEXT NOT NULL,                    -- sets/{id}/manifest.json
  thumbnail_key TEXT,                             -- usually r1 target
  content_hash  TEXT NOT NULL DEFAULT '',         -- sha256 of set.json + image hashes, for idempotent reloads
  created_at    INTEGER NOT NULL,                 -- epoch ms
  updated_at    INTEGER NOT NULL
);

-- Paged listing: WHERE status = 'active' ORDER BY created_at DESC, id DESC (keyset cursor).
CREATE INDEX IF NOT EXISTS idx_sets_listing ON challenge_sets (status, created_at DESC, id DESC);
-- Matchmaker pick: WHERE status = 'active' AND round_count >= ?.
CREATE INDEX IF NOT EXISTS idx_sets_round_count ON challenge_sets (status, round_count);

CREATE TABLE IF NOT EXISTS challenge_rounds (
  set_id          TEXT NOT NULL REFERENCES challenge_sets (id) ON DELETE CASCADE,
  round_index     INTEGER NOT NULL,               -- 1-based
  before_key      TEXT NOT NULL,                  -- sets/{id}/r{n}/before.png
  target_key      TEXT NOT NULL,                  -- sets/{id}/r{n}/target.png
  original_prompt TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  model_params    TEXT NOT NULL DEFAULT '{}',     -- JSON object
  clue            TEXT NOT NULL,
  tip             TEXT NOT NULL,
  PRIMARY KEY (set_id, round_index)
);

-- Players and matches -------------------------------------------------------

CREATE TABLE IF NOT EXISTS players (
  device_id    TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id           TEXT PRIMARY KEY,
  set_id       TEXT NOT NULL,
  player_a     TEXT NOT NULL,                     -- device id
  player_b     TEXT NOT NULL,
  rounds_total INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',    -- active | ended
  winner       TEXT,                              -- 'A' | 'B' | NULL
  end_reason   TEXT,
  tally        TEXT,                              -- JSON Tally
  totals       TEXT,                              -- JSON {A, B}
  created_at   INTEGER NOT NULL,
  ended_at     INTEGER
);

-- DAILY_DUEL_CAP counts matches created since UTC midnight.
CREATE INDEX IF NOT EXISTS idx_matches_created ON matches (created_at);
CREATE INDEX IF NOT EXISTS idx_matches_player_a ON matches (player_a, created_at);
CREATE INDEX IF NOT EXISTS idx_matches_player_b ON matches (player_b, created_at);

CREATE TABLE IF NOT EXISTS match_rounds (
  match_id        TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  round_index     INTEGER NOT NULL,               -- 1-based within the match
  set_id          TEXT NOT NULL,
  set_round_index INTEGER NOT NULL,
  outcome         TEXT NOT NULL,                  -- scored | forfeit | no_contest | void
  round_winner    TEXT,                           -- 'A' | 'B' | NULL
  prompt_a        TEXT,
  prompt_b        TEXT,
  result_a_key    TEXT,                           -- R2 key of generated image
  result_b_key    TEXT,
  quote_a         TEXT,
  quote_b         TEXT,
  lesson          TEXT,
  total_a         REAL,
  total_b         REAL,
  teacher_id      TEXT,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (match_id, round_index)
);

-- One row per sub-score, each stored with its max. part_key '_total' holds the agent total.
CREATE TABLE IF NOT EXISTS round_scores (
  match_id    TEXT NOT NULL,
  round_index INTEGER NOT NULL,
  slot        TEXT NOT NULL,                      -- 'A' | 'B'
  agent       TEXT NOT NULL,                      -- 'objective' | 'whiskers'
  part_key    TEXT NOT NULL,
  score       REAL NOT NULL,
  max         REAL NOT NULL,
  PRIMARY KEY (match_id, round_index, slot, agent, part_key),
  FOREIGN KEY (match_id, round_index) REFERENCES match_rounds (match_id, round_index) ON DELETE CASCADE
);
