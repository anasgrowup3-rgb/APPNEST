-- Standalone email/password accounts and revocable server-side sessions.
-- Existing Telegram users and all foreign-key relationships remain intact.
CREATE TABLE IF NOT EXISTS appnest_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS appnest_auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appnest_auth_sessions_user ON appnest_auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_appnest_auth_sessions_expiry ON appnest_auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS appnest_admins (
  user_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
