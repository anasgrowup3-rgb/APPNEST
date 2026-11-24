CREATE TABLE IF NOT EXISTS appnest_admin_recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_appnest_admin_recovery_user
  ON appnest_admin_recovery_codes(user_id, used_at);
