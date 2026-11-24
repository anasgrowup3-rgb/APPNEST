import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "migrations"
EXPECTED_TABLES = {
    "users", "categories", "apps", "app_versions", "favorites", "downloads",
    "feedback", "notifications", "required_channels", "settings", "ad_campaigns",
    "admin_audit", "rate_limits", "upload_sessions", "upload_parts",
    "ad_frequency", "download_tokens", "appnest_categories", "appnest_apps",
    "appnest_app_versions", "appnest_favorites", "appnest_downloads",
    "appnest_feedback", "appnest_notifications", "appnest_required_channels",
    "appnest_settings", "appnest_ad_campaigns", "appnest_admin_audit",
    "appnest_rate_limits", "appnest_upload_sessions", "appnest_upload_parts",
    "appnest_ad_frequency", "appnest_download_tokens", "appnest_credentials",
    "appnest_auth_sessions", "appnest_admins",
}

class MigrationSmokeTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")

    def tearDown(self):
        self.db.close()

    def apply_all(self):
        for migration in sorted(ROOT.glob("*.sql")):
            with self.subTest(migration=migration.name):
                self.db.executescript(migration.read_text(encoding="utf-8"))

    def test_all_migrations_apply_and_preserve_existing_user_data(self):
        self.db.executescript((ROOT / "0001_appnest.sql").read_text(encoding="utf-8"))
        self.db.execute("INSERT INTO users(telegram_id, first_name) VALUES('123', 'Existing')")
        self.db.executescript((ROOT / "0002_uploads_ads.sql").read_text(encoding="utf-8"))
        self.db.executescript((ROOT / "0003_production_compat.sql").read_text(encoding="utf-8"))
        self.db.executescript((ROOT / "0004_standalone_accounts.sql").read_text(encoding="utf-8"))
        row = self.db.execute(
            "SELECT telegram_id, first_name, language FROM users WHERE telegram_id='123'"
        ).fetchone()
        self.assertEqual(row, ("123", "Existing", "ru"))
        self.db.execute("INSERT INTO appnest_credentials(user_id,email,password_salt,password_hash) VALUES(?,?,?,?)", ("123","existing@example.com","a"*32,"b"*64))
        self.assertEqual(self.db.execute("SELECT email FROM appnest_credentials WHERE user_id='123'").fetchone()[0], "existing@example.com")

    def test_complete_schema_indexes_and_foreign_keys(self):
        self.apply_all()
        tables = {row[0] for row in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )}
        self.assertEqual(EXPECTED_TABLES, tables)
        indexes = {row[0] for row in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        )}
        self.assertTrue({
            "idx_apps_status_created", "idx_apps_category", "idx_downloads_user",
            "idx_upload_sessions_expiry", "idx_ad_frequency_day",
            "idx_download_tokens_expiry", "idx_appnest_auth_sessions_user",
            "idx_appnest_auth_sessions_expiry"
        } <= indexes)

    def test_worker_compatibility_tables_and_default_categories(self):
        self.apply_all()
        categories = {row[0] for row in self.db.execute("SELECT slug FROM appnest_categories")}
        self.assertTrue({"productivity", "games", "tools", "other"} <= categories)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_user_app_version_and_upload_relationships(self):
        self.apply_all()
        self.db.execute("INSERT INTO users(telegram_id, first_name) VALUES('42','Tester')")
        self.db.execute("""
            INSERT INTO apps(title,description,category,apk_key,apk_sha256)
            VALUES('Fixture','Fixture description','tools','apk/fixture.apk',?)
        """, ("a" * 64,))
        app_id = self.db.execute("SELECT id FROM apps").fetchone()[0]
        self.db.execute("""
            INSERT INTO app_versions(app_id,version,size_bytes,apk_key,sha256)
            VALUES(?,?,?,?,?)
        """, (app_id,"1.0",8,"apk/fixture.apk","a" * 64))
        self.db.execute("""
            INSERT INTO upload_sessions(id,owner_id,app_id,object_key,r2_upload_id,metadata_json,expected_size,expires_at)
            VALUES('upload-1','42',?,'apk/new.apk','r2-id','{}',8,9999999999)
        """, (app_id,))
        self.db.execute("""
            INSERT INTO upload_parts(upload_id,part_number,etag,size_bytes)
            VALUES('upload-1',1,'etag',8)
        """)
        self.assertEqual(self.db.execute(
            "SELECT SUM(size_bytes) FROM upload_parts WHERE upload_id='upload-1'"
        ).fetchone()[0], 8)

    def test_foreign_key_and_language_constraints_are_enforced(self):
        self.apply_all()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO favorites(user_id,app_id) VALUES('missing',999)")
        self.db.execute("INSERT INTO users(telegram_id) VALUES('42')")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE users SET language='xx' WHERE telegram_id='42'")

if __name__ == "__main__":
    unittest.main()
