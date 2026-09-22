-- Response cache for the AI chat. Cross-user cache with hash-based
-- keying: SHA256 of (normalized message + intent + sorted assets +
-- sorted protocols). Same question → same hash → shared cache hit.
--
-- TTL is enforced at read-time (WHERE cached_at > NOW() - INTERVAL).
-- No cron sweep — expired rows just get re-cached on next miss. Table
-- size self-limits because popular questions rewrite the same rows.
--
-- Added 2026-09-22.

CREATE TABLE IF NOT EXISTS chat_response_cache (
  question_hash CHAR(64) PRIMARY KEY,      -- sha256 hex
  question_preview VARCHAR(120) NOT NULL,   -- first 120 chars of message, for debugging
  intent VARCHAR(32) NOT NULL,
  response TEXT NOT NULL,                   -- final answer text (cap 32 KB)
  tool_calls JSONB,                         -- [{tool, ok, latencyMs}, ...]
  iterations INT,
  elapsed_ms INT,                           -- original LLM time (for observability)
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count INT NOT NULL DEFAULT 0,         -- incremented on each cache hit
  last_hit_at TIMESTAMPTZ                   -- when the last hit was served
);

-- Read-path index: (question_hash, cached_at) so TTL check + PK lookup
-- are both index scans. PK already covers hash lookup; add btree on
-- cached_at for the age filter on hit queries.
CREATE INDEX IF NOT EXISTS idx_chat_response_cache_cached_at
  ON chat_response_cache (cached_at DESC);

-- Operator query: which questions are HOT (highest hit counts)
CREATE INDEX IF NOT EXISTS idx_chat_response_cache_hits
  ON chat_response_cache (hit_count DESC);

COMMENT ON TABLE chat_response_cache IS
  'Cross-user AI chat response cache. 5-min TTL enforced at read. Skips LLM entirely on hit for popular questions.';
