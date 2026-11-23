import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HTML = (ROOT / "miniapp" / "index.html").read_text(encoding="utf-8")
JS = (ROOT / "miniapp" / "script.js").read_text(encoding="utf-8")
CSS = (ROOT / "miniapp" / "style.css").read_text(encoding="utf-8")

class MiniAppStaticAcceptanceTest(unittest.TestCase):
    def test_mobile_viewport_and_telegram_webapp_sdk_are_present(self):
        self.assertRegex(HTML, r'<meta[^>]+name="viewport"[^>]+width=device-width')
        self.assertIn("https://telegram.org/js/telegram-web-app.js", HTML)
        self.assertIn("tg?.ready()", JS)
        self.assertIn("tg?.expand()", JS)

    def test_required_user_and_admin_sections_exist(self):
        ids = set(re.findall(r'id="([^"]+)"', HTML))
        expected = {
            "page-home", "page-catalog", "page-favorites", "page-profile",
            "page-history", "page-notifications", "page-details", "page-admin",
            "popularApps", "recentApps", "catalogApps", "appDetailsContent",
            "adminStats", "adminAppsList", "adminFeedbackList", "bottomNav",
            "adSlot", "languageSelect", "toastContainer"
        }
        self.assertTrue(expected <= ids, f"Missing UI anchors: {sorted(expected - ids)}")
        self.assertEqual(len(re.findall(r'id="([^"]+)"', HTML)), len(ids),
                         "HTML id attributes must be unique")

    def test_all_three_locales_are_defined_and_persisted(self):
        for locale in ('tj', 'en'):
            self.assertRegex(JS, rf'(?m)^\\s*{locale}:\\s*\\{{')
        self.assertIn('["ru","tj","en"]', JS)
        self.assertIn('localStorage.setItem("appnest-language", language)', JS)
        self.assertIn('body:JSON.stringify({language})', JS)
        self.assertIn('translations[state.language]', JS)

    def test_mobile_and_accessibility_css_exists(self):
        self.assertRegex(CSS, r'@media\\s*\\(max-width:\\s*360px\\)')
        self.assertRegex(CSS, r'@media\\s*\\(max-width:\\s*480px\\)')
        self.assertIn("prefers-reduced-motion: reduce", CSS)
        self.assertIn(":focus-visible", CSS)

    def test_multipart_progress_retry_and_user_feedback_are_wired(self):
        self.assertIn("function setUploadProgress", JS)
        self.assertIn("function sendUploadPart", JS)
        self.assertIn("for(let attempt=0;attempt<3&&!done;attempt++)", JS)
        self.assertIn("uploadFileMultipart", JS)
        self.assertIn("XMLHttpRequest", JS)

    def test_ui_uses_server_verified_subscription_and_download_ticket(self):
        self.assertIn("/download-ticket", JS)
        self.assertIn("/download-ticket", JS)
        self.assertIn("subscription_required", JS)
        self.assertIn("Проверить снова", JS)

if __name__ == "__main__":
    unittest.main()
