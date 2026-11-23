import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BOT = (ROOT / "main.py").read_text(encoding="utf-8")
LEGACY = (ROOT / "main_backup.py").read_text(encoding="utf-8")

class BotSecurityAcceptanceTest(unittest.TestCase):
    def test_active_bot_does_not_log_raw_api_exception_details(self):
        self.assertIn('print("APK ERROR: upload operation failed")', BOT)
        self.assertNotIn('print("APK ERROR:", error)', BOT)

    def test_legacy_backup_is_disabled_to_prevent_direct_file_delivery(self):
        self.assertIn("Archived legacy bot entrypoint disabled; use main.py", LEGACY)
        self.assertLess(LEGACY.index("raise RuntimeError("), LEGACY.index("bot.send_document("))

    def test_active_bot_routes_app_lookup_to_mini_app_subscription_gate(self):
        self.assertIn("Зеркашӣ танҳо тавассути APPNEST дастрас аст", BOT)
        self.assertIn("Пеш аз боргирӣ санҷиши обуна ба каналҳо иҷро мешавад", BOT)
        self.assertNotIn("bot.send_document(", BOT)

if __name__ == "__main__":
    unittest.main()
