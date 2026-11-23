import os
import sqlite3
from contextlib import contextmanager
from urllib.parse import urlsplit

import telebot
from dotenv import load_dotenv
from telebot import types


# Configuration
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

TOKEN = os.getenv("BOT_TOKEN", "").strip()
WEBAPP_URL = os.getenv("WEBAPP_URL", "").strip()

if not TOKEN:
    raise ValueError("BOT_TOKEN не найден в .env")

parsed_webapp_url = urlsplit(WEBAPP_URL)
WEBAPP_READY = (
    parsed_webapp_url.scheme == "https"
    and bool(parsed_webapp_url.hostname)
    and not parsed_webapp_url.username
    and not parsed_webapp_url.password
)

bot = telebot.TeleBot(TOKEN)

# Keep the existing database file so saved language preferences survive.
# The legacy SQLite app catalog is deliberately no longer used: D1 is the
# single source of truth for applications and the Mini App admin panel.
DB_PATH = os.path.join(BASE_DIR, "data", "apps.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                language TEXT NOT NULL DEFAULT 'ru'
                    CHECK(language IN ('ru', 'tj', 'en'))
            )
        """)


init_db()


def get_language(user_id):
    with db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO users (user_id, language) VALUES (?, 'ru')",
            (user_id,),
        )
        row = conn.execute(
            "SELECT language FROM users WHERE user_id = ?",
            (user_id,),
        ).fetchone()
    return row[0] if row else "ru"


def save_language(user_id, language):
    if language not in TEXTS:
        return
    with db() as conn:
        conn.execute("""
            INSERT INTO users (user_id, language)
            VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET language = excluded.language
        """, (user_id, language))


TEXTS = {
    "ru": {
        "welcome": "Добро пожаловать в APPNEST!\n\nОткрывай каталог, изучай приложения и скачивай APK через защищённую систему.",
        "open": "📱 Открыть APPNEST",
        "help": "APPNEST — каталог Android-приложений.\n\n/open или /catalog — открыть каталог\n/language — сменить язык\n/id — узнать свой Telegram ID",
        "not_configured": "Каталог пока не подключён. Администратору нужно настроить WEBAPP_URL в .env.",
        "admin": "Управление приложениями теперь находится в панели администратора APPNEST. Открой Mini App и войди с аккаунтом администратора.",
        "open_hint": "Нажми кнопку ниже, чтобы открыть каталог APPNEST.",
        "language": "Выбери язык:",
        "language_saved": "Язык изменён на русский.",
        "id": "Твой Telegram ID: {user_id}",
        "document": "Загрузка APK через чат отключена. Добавляй приложения и файлы через панель администратора APPNEST.",
    },
    "tj": {
        "welcome": "Ба APPNEST хуш омадед!\n\nКаталогро кушоед, барномаҳоро бинед ва APK-ро тавассути низоми муҳофизатшуда зеркашӣ кунед.",
        "open": "📱 Кушодани APPNEST",
        "help": "APPNEST — каталоги барномаҳои Android.\n\n/open ё /catalog — кушодани каталог\n/language — иваз кардани забон\n/id — гирифтани Telegram ID",
        "not_configured": "Каталог ҳоло пайваст нашудааст. Администратор бояд WEBAPP_URL-ро дар .env танзим кунад.",
        "admin": "Идоракунии барномаҳо ҳоло дар панели администратори APPNEST ҷойгир аст. Mini App-ро кушоед ва бо ҳисоби администратор ворид шавед.",
        "open_hint": "Барои кушодани каталоги APPNEST тугмаи поёнро пахш кунед.",
        "language": "Забонро интихоб кунед:",
        "language_saved": "Забон ба тоҷикӣ иваз шуд.",
        "id": "Telegram ID-и шумо: {user_id}",
        "document": "Боркунии APK тавассути чат хомӯш аст. Барномаҳо ва файлҳоро аз панели администратори APPNEST илова кунед.",
    },
    "en": {
        "welcome": "Welcome to APPNEST!\n\nExplore the catalog, discover apps, and download APK files through the protected download system.",
        "open": "📱 Open APPNEST",
        "help": "APPNEST is an Android app catalog.\n\n/open or /catalog — open the catalog\n/language — change language\n/id — show your Telegram ID",
        "not_configured": "The catalog is not connected yet. An administrator must configure WEBAPP_URL in .env.",
        "admin": "App management is now available in the APPNEST admin panel. Open the Mini App and sign in with an administrator account.",
        "open_hint": "Tap the button below to open the APPNEST catalog.",
        "language": "Choose your language:",
        "language_saved": "Language changed to English.",
        "id": "Your Telegram ID: {user_id}",
        "document": "APK uploads through chat are disabled. Add apps and files through the APPNEST admin panel.",
    },
}


def webapp_keyboard(language="ru"):
    if not WEBAPP_READY:
        return None
    keyboard = types.InlineKeyboardMarkup()
    keyboard.add(types.InlineKeyboardButton(
        TEXTS.get(language, TEXTS["ru"])["open"],
        web_app=types.WebAppInfo(url=WEBAPP_URL),
    ))
    return keyboard


def language_keyboard():
    keyboard = types.InlineKeyboardMarkup()
    keyboard.row(
        types.InlineKeyboardButton("🇷🇺 Русский", callback_data="lang_ru"),
        types.InlineKeyboardButton("🇹🇯 Тоҷикӣ", callback_data="lang_tj"),
        types.InlineKeyboardButton("🇬🇧 English", callback_data="lang_en"),
    )
    return keyboard


def send_welcome(chat_id, user_id):
    language = get_language(user_id)
    text = TEXTS[language]["welcome"]
    keyboard = webapp_keyboard(language)
    if not WEBAPP_READY:
        text += "\n\n" + TEXTS[language]["not_configured"]
    bot.send_message(chat_id, text, reply_markup=keyboard)


def open_mini_app(message):
    language = get_language(message.from_user.id)
    if not WEBAPP_READY:
        bot.reply_to(message, TEXTS[language]["not_configured"])
        return
    bot.send_message(
        message.chat.id,
        TEXTS[language]["open_hint"],
        reply_markup=webapp_keyboard(language),
    )


@bot.message_handler(commands=["start"])
def start(message):
    send_welcome(message.chat.id, message.from_user.id)


@bot.message_handler(commands=["open", "catalog", "admin"])
def open_command(message):
    open_mini_app(message)


@bot.message_handler(commands=["language"])
def change_language(message):
    language = get_language(message.from_user.id)
    bot.send_message(
        message.chat.id,
        TEXTS[language]["language"],
        reply_markup=language_keyboard(),
    )


@bot.callback_query_handler(func=lambda call: call.data.startswith("lang_"))
def choose_language(call):
    language = call.data[5:]
    if language not in TEXTS:
        bot.answer_callback_query(call.id, "Unknown language")
        return

    save_language(call.from_user.id, language)
    bot.answer_callback_query(call.id)
    send_welcome(call.message.chat.id, call.from_user.id)


@bot.message_handler(commands=["help"])
def help_command(message):
    language = get_language(message.from_user.id)
    bot.send_message(
        message.chat.id,
        TEXTS[language]["help"],
        reply_markup=webapp_keyboard(language),
    )


@bot.message_handler(commands=["id"])
def get_id(message):
    language = get_language(message.from_user.id)
    bot.reply_to(
        message,
        TEXTS[language]["id"].format(user_id=message.from_user.id),
    )


@bot.message_handler(commands=["addapp", "editapp", "deleteapp", "apps", "stats"])
def legacy_admin_commands(message):
    # These legacy commands used a separate SQLite catalog and are retired.
    # All catalog administration now goes through the authenticated Mini App.
    open_mini_app(message)


@bot.message_handler(content_types=["document"])
def reject_chat_upload(message):
    language = get_language(message.from_user.id)
    bot.reply_to(message, TEXTS[language]["document"])


@bot.message_handler(content_types=["text"])
def text_fallback(message):
    if not message.text or message.text.startswith("/"):
        return
    open_mini_app(message)


def register_commands():
    commands = [
        types.BotCommand("start", "Запустить APPNEST"),
        types.BotCommand("open", "Открыть каталог"),
        types.BotCommand("catalog", "Открыть каталог"),
        types.BotCommand("language", "Сменить язык"),
        types.BotCommand("help", "Помощь"),
        types.BotCommand("id", "Мой Telegram ID"),
    ]
    try:
        bot.set_my_commands(commands)
    except Exception as error:
        # A temporary Telegram API issue should not prevent polling from starting.
        print("Не удалось обновить меню команд Telegram:", type(error).__name__)


if __name__ == "__main__":
    register_commands()
    print("APPNEST bot started.")
    bot.infinity_polling(skip_pending=True, timeout=30, long_polling_timeout=30)
