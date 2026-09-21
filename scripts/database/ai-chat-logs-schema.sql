-- AI Chat Logs — persist every live-chat interaction for
--   (a) operator visibility into what users are asking
--   (b) future retrieval-augmented context (LLM can pull prior
--       messages by session_id when answering follow-ups)
--   (c) prompt-iteration data (which questions get repeat asks,
--       which get thumbs-down)
--
-- Client generates a session_id UUID once (localStorage) and sends
-- it with every chat request. No user-auth needed — the id is
-- browser-scoped and disposable. If the user clears their
-- localStorage the id resets and prior context is lost (by design).
--
-- Added 2026-09-21.

CREATE TABLE IF NOT EXISTS ai_chat_logs (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL,
  role VARCHAR(16) NOT NULL,               -- 'user' | 'assistant'
  content TEXT NOT NULL,                    -- capped to 32 KB by app
  tool_calls JSONB,                         -- [{tool, ok, latencyMs}, ...]
  elapsed_ms INTEGER,                       -- assistant reply latency
  iterations INTEGER,                       -- LLM tool-use rounds
  finished_normally BOOLEAN,                -- vs hit maxIterations
  user_agent VARCHAR(200),                  -- request UA header (locale + device inference)
  ip_hash VARCHAR(64),                      -- sha256(ip + salt); privacy-preserving rate-limit signal
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Session-scoped lookups (retrieval on next question in same session)
CREATE INDEX IF NOT EXISTS idx_ai_chat_logs_session_time
  ON ai_chat_logs (session_id, created_at DESC);

-- Operator queries: what's being asked lately
CREATE INDEX IF NOT EXISTS idx_ai_chat_logs_created
  ON ai_chat_logs (created_at DESC);

COMMENT ON TABLE ai_chat_logs IS
  'Live AI chat message log for RAG context + operator visibility. Fire-and-forget writes from /api/agents/live-chat.';
