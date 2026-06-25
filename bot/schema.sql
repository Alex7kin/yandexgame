-- Central best-score store: one row per (game, player).
-- Apply with:  npx wrangler d1 execute gamezone --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS scores (
  game_id    TEXT    NOT NULL,
  user_id    INTEGER NOT NULL,
  name       TEXT,
  best       INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_scores_game_best ON scores (game_id, best DESC);
