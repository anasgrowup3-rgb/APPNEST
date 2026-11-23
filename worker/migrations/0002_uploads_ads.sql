-- APPNEST additive operational features. Safe to apply repeatedly; no existing records are deleted.
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(telegram_id),
  app_id INTEGER REFERENCES apps(id),
  object_key TEXT NOT NULL UNIQUE,
  r2_upload_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','aborted','failed')),
  expected_size INTEGER NOT NULL,
  client_sha256 TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY(upload_id,part_number)
);
CREATE TABLE IF NOT EXISTS ad_frequency (
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  ad_id INTEGER NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,ad_id,day)
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expiry ON upload_sessions(status,expires_at);
CREATE INDEX IF NOT EXISTS idx_ad_frequency_day ON ad_frequency(day,ad_id);

ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'ru' CHECK(language IN ('ru','tj','en'));

INSERT OR IGNORE INTO categories(slug,title,icon,sort_order) VALUES
('productivity','Продуктивность','✦',1),
('games','Игры','◈',2),
('tools','Инструменты','⌘',3),
('other','Другое','◇',4);
