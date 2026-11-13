-- Two-way Telegram chat (2026-11-13): remember which agent sent each bot
-- message, so replying to it continues the conversation with that agent, and
-- keep a short chat history per agent for context.
CREATE TABLE IF NOT EXISTS telegram_messages (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     BIGINT NOT NULL,
  message_id  BIGINT,
  agent_id    TEXT REFERENCES agents(id),
  task_id     UUID,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_messages_msg ON telegram_messages(chat_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telegram_messages_agent ON telegram_messages(agent_id, created_at DESC);
