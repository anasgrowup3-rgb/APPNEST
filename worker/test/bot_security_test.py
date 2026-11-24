import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BOT = (ROOT / "main.py").read_text(encoding="utf-8")
LEGACY = (ROOT / "main_backup.py").read_text(encoding="utf-8")


class BotSecurityAcceptanceTest(unittest.TestCase):
    def test_legacy_backup_is_disabled_to_prevent_direct_file_delivery(self):
        self.assertIn("Archived legacy bot entrypoint disabled; use main.py", LEGACY)
        self.assertLess(LEGACY.index("raise RuntimeError("), LEGACY.index("bot.send_document("))

    def test_active_bot_never_sends_apk_files_directly(self):
        self.assertNotIn("bot.send_document(", BOT)
        self.assertIn("def reject_chat_upload(message):", BOT)
        self.assertIn("def open_mini_app(message):", BOT)

    def test_d1_mini_app_is_the_only_application_catalog(self):
        self.assertNotIn("CREATE TABLE IF NOT EXISTS apps", BOT)
        self.assertNotIn("def get_app(", BOT)
        self.assertNotIn("def save_app(", BOT)
        self.assertIn('commands=["addapp", "editapp", "deleteapp", "apps", "stats"]', BOT)
        self.assertIn("open_mini_app(message)", BOT)

    def test_bot_keeps_language_preferences_and_supported_languages(self):
        self.assertIn("CREATE TABLE IF NOT EXISTS users", BOT)
        self.assertIn('"ru":', BOT)
        self.assertIn('"tj":', BOT)
        self.assertIn('"en":', BOT)
        self.assertIn("def save_language(user_id, language):", BOT)

    def test_bot_uses_only_https_web_app_url(self):
        self.assertIn('parsed_webapp_url.scheme == "https"', BOT)
        self.assertIn("types.WebAppInfo(url=WEBAPP_URL)", BOT)

    def test_bot_command_menu_points_to_the_mini_app(self):
        self.assertIn('types.BotCommand("open"', BOT)
        self.assertIn('types.BotCommand("catalog"', BOT)
        self.assertIn('types.BotCommand("language"', BOT)


if __name__ == "__main__":
    unittest.main()
