import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "migrations"

class MigrationSmokeTest(unittest.TestCase):
    def test_additive_migrations_apply_and_preserve_existing_user(self):
        db = sqlite3.connect(":memory:")
        db.execute("PRAGMA foreign_keys = ON")
        db.executescript((ROOT / "0001_appnest.sql").read_text())
        db.execute("INSERT INTO users(telegram_id, first_name) VALUES('123', 'Existing')")
        db.executescript((ROOT / "0002_uploads_ads.sql").read_text())
        row = db.execute("SELECT telegram_id, first_name, language FROM users WHERE telegram_id='123'").fetchone()
        self.assertEqual(row, ("123", "Existing", "ru"))
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"upload_sessions", "upload_parts", "ad_frequency", "app_versions"} <= tables)
        db.close()

if __name__ == "__main__":
    unittest.main()
