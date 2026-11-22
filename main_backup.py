
import os
import sqlite3
import telebot
from dotenv import load_dotenv
from telebot import types

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

TOKEN = os.getenv("BOT_TOKEN", "").strip()
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))

if not TOKEN:
    raise ValueError("BOT_TOKEN не найден в .env")

bot = telebot.TeleBot(TOKEN)

DB_PATH = os.path.join(BASE_DIR, "data", "apps.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


def db():
    return sqlite3.connect(DB_PATH)


def init_db():
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS apps (
                code TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                link TEXT NOT NULL
            )
        """)


init_db()

user_languages = {}
admin_states = {}

TEXTS = {
    "ru": {
        "welcome": "👋 Добро пожаловать в APPNEST!\n\nВведи код приложения.",
        "not_found": "❌ Приложение с таким кодом не найдено.",
    },
    "tj": {
        "welcome": "👋 Ба APPNEST хуш омадед!\n\nРамзи барномаро ворид кунед.",
        "not_found": "❌ Барнома ёфт нашуд.",
    },
    "en": {
        "welcome": "👋 Welcome to APPNEST!\n\nEnter an app code.",
        "not_found": "❌ App not found.",
    }
}


def language_keyboard():
    keyboard = types.InlineKeyboardMarkup()
    keyboard.row(
        types.InlineKeyboardButton("🇷🇺 Русский", callback_data="lang_ru"),
        types.InlineKeyboardButton("🇹🇯 Тоҷикӣ", callback_data="lang_tj"),
        types.InlineKeyboardButton("🇬🇧 English", callback_data="lang_en")
    )
    return keyboard


@bot.message_handler(commands=["start"])
def start(message):
    bot.send_message(
        message.chat.id,
        "🌐 Выбери язык / Забонро интихоб кунед / Choose language:",
        reply_markup=language_keyboard()
    )


@bot.callback_query_handler(func=lambda call: call.data.startswith("lang_"))
def choose_language(call):
    lang = call.data.replace("lang_", "")

    if lang not in TEXTS:
        return

    user_languages[call.from_user.id] = lang
    bot.answer_callback_query(call.id)

    bot.send_message(
        call.message.chat.id,
        TEXTS[lang]["welcome"]
    )


@bot.message_handler(commands=["language"])
def change_language(message):
    bot.send_message(
        message.chat.id,
        "🌐 Choose language / Выбери язык:",
        reply_markup=language_keyboard()
    )


@bot.message_handler(commands=["id"])
def get_id(message):
    bot.reply_to(
        message,
        f"Твой Telegram ID: {message.from_user.id}"
    )


@bot.message_handler(commands=["cancel"])
def cancel(message):
    admin_states.pop(message.from_user.id, None)
    bot.reply_to(message, "❌ Действие отменено.")


@bot.message_handler(commands=["addapp"])
def add_app_start(message):
    if message.from_user.id != ADMIN_ID:
        bot.reply_to(message, "⛔ У тебя нет доступа.")
        return

    admin_states[message.from_user.id] = {"step": "code"}

    bot.reply_to(
        message,
        "Введи уникальный код приложения, например 0002:"
    )


def save_app(code, title, description, file_id):
    with db() as conn:
        conn.execute(
            """
            INSERT INTO apps (code, title, description, link)
            VALUES (?, ?, ?, ?)
            """,
            (code, title, description, file_id)
        )


@bot.message_handler(content_types=["document"])
def handle_apk(message):
    user_id = message.from_user.id

    if user_id not in admin_states:
        return

    state = admin_states[user_id]

    if state["step"] != "apk":
        return

    document = message.document
    filename = (document.file_name or "").lower()

    if not filename.endswith(".apk"):
        bot.reply_to(
            message,
            "❌ Это не APK. Отправь файл с расширением .apk."
        )
        return

    try:
        save_app(
            state["code"],
            state["title"],
            state["description"],
            document.file_id
        )

        bot.reply_to(
            message,
            f"✅ Приложение добавлено!\n\n"
            f"Код: {state['code']}\n"
            f"Название: {state['title']}\n"
            f"APK сохранён."
        )

    except sqlite3.IntegrityError:
        bot.reply_to(
            message,
            "❌ Такой код уже занят. Используй другой."
        )

    finally:
        admin_states.pop(user_id, None)


@bot.message_handler(content_types=["text"])
def handle_text(message):
    user_id = message.from_user.id
    text = message.text.strip()
    lang = user_languages.get(user_id, "ru")

    if user_id in admin_states:
        state = admin_states[user_id]
        step = state["step"]

        if step == "code":
            if not text.isdigit() or not (4 <= len(text) <= 12):
                bot.reply_to(
                    message,
                    "Код должен содержать от 4 до 12 цифр."
                )
                return

            state["code"] = text
            state["step"] = "title"

            bot.reply_to(message, "Введи название приложения:")
            return

        if step == "title":
            state["title"] = text
            state["step"] = "description"

            bot.reply_to(message, "Введи описание приложения:")
            return

        if step == "description":
            state["description"] = text
            state["step"] = "apk"

            bot.reply_to(
                message,
                "📦 Теперь отправь APK-файл как документ."
            )
            return

    if text.startswith("/"):
        return

    with db() as conn:
        app = conn.execute(
            "SELECT title, description, link FROM apps WHERE code = ?",
            (text,)
        ).fetchone()

    if app:
        title, description, file_id = app

        bot.send_document(
            message.chat.id,
            file_id,
            caption=f"📱 {title}\n\n{description}"
        )
    else:
        bot.reply_to(
            message,
            TEXTS[lang]["not_found"]
        )


print("APPNEST запущен!")
bot.infinity_polling(skip_pending=True)
