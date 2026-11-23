
import os
import sqlite3
import telebot

from contextlib import contextmanager
from dotenv import load_dotenv
from telebot import types

# =========================
# CONFIGURATION
# =========================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

TOKEN = os.getenv("BOT_TOKEN", "").strip()
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))
WEBAPP_URL = os.getenv("WEBAPP_URL", "").strip()

if not TOKEN:
    raise ValueError("BOT_TOKEN не найден в .env")

if not ADMIN_ID:
    raise ValueError("ADMIN_ID не найден в .env")

bot = telebot.TeleBot(TOKEN)

DB_PATH = os.path.join(BASE_DIR, "data", "apps.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


# =========================
# DATABASE
# =========================

@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


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

        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                language TEXT NOT NULL DEFAULT 'ru'
            )
        """)


init_db()


def get_language(user_id):
    with db() as conn:
        row = conn.execute(
            "SELECT language FROM users WHERE user_id = ?",
            (user_id,)
        ).fetchone()

    return row[0] if row else "ru"


def save_language(user_id, language):
    with db() as conn:
        conn.execute("""
            INSERT INTO users (user_id, language)
            VALUES (?, ?)
            ON CONFLICT(user_id)
            DO UPDATE SET language = excluded.language
        """, (user_id, language))


def get_app(code):
    with db() as conn:
        return conn.execute("""
            SELECT code, title, description, link
            FROM apps WHERE code = ?
        """, (code,)).fetchone()


# =========================
# LANGUAGES
# =========================

TEXTS = {
    "ru": {
        "welcome": (
            "👋 Добро пожаловать в APPNEST!\n\n"
            "Введи код приложения, чтобы получить APK."
        ),
        "not_found": "❌ Приложение с таким кодом не найдено.",
        "language": "🌐 Выбери язык:",
        "help": "📱 Отправь код приложения, чтобы получить его APK."
    },
    "tj": {
        "welcome": (
            "👋 Ба APPNEST хуш омадед!\n\n"
            "Барои гирифтани APK рамзи барномаро ворид кунед."
        ),
        "not_found": "❌ Барнома бо чунин рамз ёфт нашуд.",
        "language": "🌐 Забонро интихоб кунед:",
        "help": "📱 Барои гирифтани APK рамзи барномаро фиристед."
    },
    "en": {
        "welcome": (
            "👋 Welcome to APPNEST!\n\n"
            "Enter an app code to receive its APK."
        ),
        "not_found": "❌ App with this code was not found.",
        "language": "🌐 Choose your language:",
        "help": "📱 Send an app code to receive its APK."
    }
}


def webapp_keyboard():
    keyboard = types.ReplyKeyboardMarkup(resize_keyboard=True)
    if WEBAPP_URL.startswith("https://"):
        keyboard.add(types.KeyboardButton("📱 Открыть APPNEST", web_app=types.WebAppInfo(url=WEBAPP_URL)))
    return keyboard


def language_keyboard():
    keyboard = types.InlineKeyboardMarkup()
    keyboard.row(
        types.InlineKeyboardButton(
            "🇷🇺 Русский", callback_data="lang_ru"
        ),
        types.InlineKeyboardButton(
            "🇹🇯 Тоҷикӣ", callback_data="lang_tj"
        ),
        types.InlineKeyboardButton(
            "🇬🇧 English", callback_data="lang_en"
        )
    )
    return keyboard


# =========================
# ADMIN STATES
# =========================

admin_states = {}


def is_admin(message):
    return message.from_user.id == ADMIN_ID


def admin_check(message):
    if not is_admin(message):
        bot.reply_to(message, "⛔ У тебя нет доступа.")
        return False
    return True


# =========================
# START
# =========================

@bot.message_handler(commands=["start"])
def start(message):
    bot.send_message(
        message.chat.id,
        TEXTS["ru"]["language"],
        reply_markup=language_keyboard()
    )


@bot.callback_query_handler(
    func=lambda call: call.data.startswith("lang_")
)
def choose_language(call):
    language = call.data.replace("lang_", "")

    if language not in TEXTS:
        bot.answer_callback_query(call.id)
        return

    save_language(call.from_user.id, language)

    bot.answer_callback_query(call.id)

    bot.send_message(
        call.message.chat.id,
        TEXTS[language]["welcome"],
        reply_markup=webapp_keyboard()
    )


@bot.message_handler(commands=["language"])
def change_language(message):
    bot.send_message(
        message.chat.id,
        "🌐 Выбери язык / Choose language:",
        reply_markup=language_keyboard()
    )


@bot.message_handler(commands=["open", "catalog"])
def open_mini_app(message):
    if not WEBAPP_URL.startswith("https://"):
        bot.reply_to(message, "Mini App пока не настроен. Администратор должен указать WEBAPP_URL (HTTPS).")
        return
    bot.send_message(
        message.chat.id,
        "Открой каталог APPNEST:",
        reply_markup=webapp_keyboard()
    )


# =========================
# HELP
# =========================

@bot.message_handler(commands=["help"])
def help_command(message):
    lang = get_language(message.from_user.id)

    if is_admin(message):
        text = (
            "📚 APPNEST — команды администратора\n\n"
            "/addapp — добавить приложение\n"
            "/editapp — изменить приложение\n"
            "/deleteapp — удалить приложение\n"
            "/apps — список приложений\n"
            "/stats — статистика каталога\n"
            "/cancel — отменить действие\n"
            "/id — узнать свой ID\n"
            "/open — открыть Mini App\n"
            "/help — помощь"
        )
    else:
        text = TEXTS[lang]["help"]

    bot.send_message(message.chat.id, text)


# =========================
# ID
# =========================

@bot.message_handler(commands=["id"])
def get_id(message):
    bot.reply_to(
        message,
        f"Твой Telegram ID: {message.from_user.id}"
    )


# =========================
# CANCEL
# =========================

@bot.message_handler(commands=["cancel"])
def cancel(message):
    admin_states.pop(message.from_user.id, None)
    bot.reply_to(message, "❌ Действие отменено.")


# =========================
# ADD APP
# =========================

@bot.message_handler(commands=["addapp"])
def add_app_start(message):
    if not admin_check(message):
        return

    admin_states[message.from_user.id] = {
        "action": "add",
        "step": "code"
    }

    bot.reply_to(
        message,
        "➕ Добавление приложения\n\n"
        "Введи уникальный код, например 0002:"
    )


def save_app(code, title, description, file_id):
    with db() as conn:
        conn.execute("""
            INSERT INTO apps (code, title, description, link)
            VALUES (?, ?, ?, ?)
        """, (code, title, description, file_id))


# =========================
# EDIT APP
# =========================

@bot.message_handler(commands=["editapp"])
def edit_app_start(message):
    if not admin_check(message):
        return

    admin_states[message.from_user.id] = {
        "action": "edit",
        "step": "code"
    }

    bot.reply_to(
        message,
        "✏️ Изменение приложения\n\n"
        "Введи код приложения:"
    )


def edit_keyboard():
    keyboard = types.InlineKeyboardMarkup()

    keyboard.row(
        types.InlineKeyboardButton(
            "📝 Название", callback_data="edit_title"
        ),
        types.InlineKeyboardButton(
            "📄 Описание", callback_data="edit_description"
        )
    )

    keyboard.row(
        types.InlineKeyboardButton(
            "📦 Заменить APK", callback_data="edit_apk"
        )
    )

    return keyboard


@bot.callback_query_handler(
    func=lambda call: call.data.startswith("edit_")
)
def edit_choice(call):
    user_id = call.from_user.id

    if user_id != ADMIN_ID:
        bot.answer_callback_query(
            call.id, "Нет доступа", show_alert=True
        )
        return

    state = admin_states.get(user_id)

    if not state or state.get("action") != "edit":
        bot.answer_callback_query(call.id)
        return

    choice = call.data.replace("edit_", "")

    if choice not in ["title", "description", "apk"]:
        bot.answer_callback_query(call.id)
        return

    state["step"] = choice

    prompts = {
        "title": "Введи новое название приложения:",
        "description": "Введи новое описание:",
        "apk": "📦 Отправь новый APK-файл как документ:"
    }

    bot.answer_callback_query(call.id)

    bot.send_message(
        call.message.chat.id,
        prompts[choice]
    )


# =========================
# DELETE APP
# =========================

@bot.message_handler(commands=["deleteapp"])
def delete_app_start(message):
    if not admin_check(message):
        return

    admin_states[message.from_user.id] = {
        "action": "delete",
        "step": "code"
    }

    bot.reply_to(
        message,
        "🗑 Удаление приложения\n\n"
        "Введи код приложения:"
    )


@bot.callback_query_handler(
    func=lambda call: call.data.startswith("delete_")
)
def delete_confirmation(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(
            call.id, "Нет доступа", show_alert=True
        )
        return

    state = admin_states.get(call.from_user.id)

    if not state or state.get("action") != "delete":
        bot.answer_callback_query(call.id)
        return

    code = state.get("code")

    if call.data == "delete_yes":
        with db() as conn:
            cursor = conn.execute(
                "DELETE FROM apps WHERE code = ?",
                (code,)
            )

        if cursor.rowcount:
            bot.send_message(
                call.message.chat.id,
                f"✅ Приложение {code} удалено."
            )
        else:
            bot.send_message(
                call.message.chat.id,
                "❌ Приложение не найдено."
            )

        admin_states.pop(call.from_user.id, None)

    elif call.data == "delete_no":
        admin_states.pop(call.from_user.id, None)

        bot.send_message(
            call.message.chat.id,
            "Удаление отменено."
        )

    bot.answer_callback_query(call.id)


# =========================
# APK HANDLER
# =========================

@bot.message_handler(content_types=["document"])
def handle_apk(message):
    user_id = message.from_user.id

    if user_id != ADMIN_ID:
        return

    state = admin_states.get(user_id)

    if not state:
        return

    action = state.get("action")
    step = state.get("step")

    if step != "apk":
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
        if action == "add":
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
                f"Название: {state['title']}"
            )

        elif action == "edit":
            with db() as conn:
                cursor = conn.execute("""
                    UPDATE apps SET link = ?
                    WHERE code = ?
                """, (document.file_id, state["code"]))

            if cursor.rowcount:
                bot.reply_to(
                    message,
                    "✅ APK успешно заменён!"
                )
            else:
                bot.reply_to(
                    message,
                    "❌ Приложение не найдено."
                )

        admin_states.pop(user_id, None)

    except sqlite3.IntegrityError:
        bot.reply_to(
            message,
            "❌ Такой код уже занят. Используй другой."
        )
        admin_states.pop(user_id, None)

    except Exception as error:
        print("APK ERROR: upload operation failed")
        bot.reply_to(
            message,
            "❌ Ошибка при сохранении APK."
        )


# =========================
# ADMIN TEXT PROCESSING
# =========================

@bot.message_handler(content_types=["text"])
def handle_text(message):
    user_id = message.from_user.id
    text = message.text.strip()

    lang = get_language(user_id)

    if user_id in admin_states:
        state = admin_states[user_id]
        action = state.get("action")
        step = state.get("step")

        # ADD APP

        if action == "add":

            if step == "code":
                if not text.isdigit() or not (4 <= len(text) <= 12):
                    bot.reply_to(
                        message,
                        "Код должен содержать от 4 до 12 цифр."
                    )
                    return

                if get_app(text):
                    bot.reply_to(
                        message,
                        "❌ Такой код уже существует. Введи другой."
                    )
                    return

                state["code"] = text
                state["step"] = "title"

                bot.reply_to(
                    message,
                    "Введи название приложения:"
                )
                return

            if step == "title":
                state["title"] = text
                state["step"] = "description"

                bot.reply_to(
                    message,
                    "Введи описание приложения:"
                )
                return

            if step == "description":
                state["description"] = text
                state["step"] = "apk"

                bot.reply_to(
                    message,
                    "📦 Теперь отправь APK-файл как документ."
                )
                return

        # EDIT APP

        elif action == "edit":

            if step == "code":
                app = get_app(text)

                if not app:
                    bot.reply_to(
                        message,
                        "❌ Приложение с таким кодом не найдено."
                    )
                    return

                state["code"] = text

                bot.send_message(
                    message.chat.id,
                    f"📱 {app[1]}\n\n"
                    f"Код: {app[0]}\n\n"
                    f"Что хочешь изменить?",
                    reply_markup=edit_keyboard()
                )
                return

            if step == "title":
                with db() as conn:
                    conn.execute(
                        "UPDATE apps SET title = ? WHERE code = ?",
                        (text, state["code"])
                    )

                bot.reply_to(
                    message,
                    "✅ Название успешно изменено."
                )
                admin_states.pop(user_id, None)
                return

            if step == "description":
                with db() as conn:
                    conn.execute(
                        "UPDATE apps SET description = ? WHERE code = ?",
                        (text, state["code"])
                    )

                bot.reply_to(
                    message,
                    "✅ Описание успешно изменено."
                )
                admin_states.pop(user_id, None)
                return

        # DELETE APP

        elif action == "delete":

            if step == "code":
                app = get_app(text)

                if not app:
                    bot.reply_to(
                        message,
                        "❌ Приложение не найдено."
                    )
                    return

                state["code"] = text

                keyboard = types.InlineKeyboardMarkup()
                keyboard.row(
                    types.InlineKeyboardButton(
                        "✅ Да, удалить",
                        callback_data="delete_yes"
                    ),
                    types.InlineKeyboardButton(
                        "❌ Отмена",
                        callback_data="delete_no"
                    )
                )

                bot.send_message(
                    message.chat.id,
                    f"⚠️ Удалить приложение {app[1]}?\n"
                    f"Код: {app[0]}",
                    reply_markup=keyboard
                )
                return

    # Ignore other commands

    if text.startswith("/"):
        return

    # APP LOOKUP

    app = get_app(text)

    if app:
        code, title, description, _file_id = app
        # Legacy SQLite file_id delivery bypasses D1 channel-subscription enforcement.
        # All end-user APK downloads must go through the authenticated Mini App Worker.
        if WEBAPP_URL.startswith("https://"):
            bot.reply_to(
                message,
                f"📱 {title}\n\n{description}\n\n"
                "Барномаро дар APPNEST кушоед. Пеш аз боргирӣ санҷиши обуна ба каналҳо иҷро мешавад.",
                reply_markup=webapp_keyboard()
            )
        else:
            bot.reply_to(
                message,
                "Зеркашӣ танҳо тавассути APPNEST дастрас аст. Mini App ҳоло танзим нашудааст."
            )
    else:
        bot.reply_to(
            message,
            TEXTS[lang]["not_found"]
        )


# =========================
# APP LIST
# =========================

@bot.message_handler(commands=["apps"])
def list_apps(message):
    if not admin_check(message):
        return

    with db() as conn:
        apps = conn.execute("""
            SELECT code, title FROM apps ORDER BY code
        """).fetchall()

    if not apps:
        bot.send_message(
            message.chat.id,
            "📭 Каталог пока пуст."
        )
        return

    result = "📱 APPNEST — каталог\n\n"

    for code, title in apps:
        result += f"🔹 {code} — {title}\n"

    bot.send_message(message.chat.id, result)


# =========================
# STATISTICS
# =========================

@bot.message_handler(commands=["stats"])
def statistics(message):
    if not admin_check(message):
        return

    with db() as conn:
        apps_count = conn.execute(
            "SELECT COUNT(*) FROM apps"
        ).fetchone()[0]

        users_count = conn.execute(
            "SELECT COUNT(*) FROM users"
        ).fetchone()[0]

    bot.send_message(
        message.chat.id,
        "📊 APPNEST — статистика\n\n"
        f"📱 Приложений в каталоге: {apps_count}\n"
        f"👥 Пользователей с выбранным языком: {users_count}"
    )


# =========================
# RUN
# =========================

print("APPNEST запущен!")
bot.infinity_polling(skip_pending=True)
