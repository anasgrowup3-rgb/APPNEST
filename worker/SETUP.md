# APPNEST Cloudflare Worker setup

This release keeps the existing static Mini App and Python bot. The Worker API uses D1 + private R2.

## Required bindings (configure in Cloudflare dashboard or wrangler secrets/settings)
- D1 database binding **DB**.
- R2 bucket binding **FILES**. Keep the bucket private; do not enable public development URLs or custom public domains.
- Secret **BOT_TOKEN**: Telegram bot token (never commit it).
- Variable **ADMIN_IDS**: comma-separated numeric Telegram user IDs.
- Variable **ALLOWED_ORIGIN**: exact Mini App origin, e.g. https://your-miniapp.example (avoid * in production).
- Optional **TELEGRAM_AUTH_MAX_AGE** (seconds, default 86400), **MAX_APK_BYTES** (default 1 GiB).

The current wrangler config intentionally does not invent a D1 database_id or bucket name. Add the actual resource identifiers to the existing configuration before deployment.

## Migration
Run `npx wrangler d1 migrations apply <YOUR_DATABASE> --remote` after placing this SQL in a migration directory (or execute it through D1 console). It is additive and does not delete existing data. Back up D1 first.

## API notes
- All user routes require a fresh, valid Telegram WebApp initData signature.
- APK bytes are streamed through the Worker only after subscription verification. Never expose R2 public URLs.
- The bot must be an administrator in each required channel to call getChatMember reliably.
- Subscription checks fail closed on Telegram API errors.
- Upload currently supports direct multipart/form-data requests up to MAX_APK_BYTES, but buffering the full file in Worker memory is not a resumable multipart R2 upload. Large-file multipart sessions and app version management require a separate resumable upload flow before production use.
- SHA-256 and ZIP signature are checked at upload. This does not establish that an APK is safe to install; perform malware/static analysis separately.
- The D1 rate limiter is persisted; deploy migrations before enabling API traffic.

## Routes
Public: GET /api/health, GET /api/apps.
Authenticated: GET /api/me, POST/DELETE /api/favorites/:id, POST /api/apps/:id/download, GET /api/ads, POST /api/ads/:id/impression|click, GET /api/subscription/status, POST /api/feedback.
Admin: GET /api/admin/overview, POST /api/admin/apps, PATCH /api/admin/apps/:id, POST /api/admin/channels, PUT /api/admin/subscription-mode, POST /api/admin/ads, PATCH /api/admin/users/:telegramId, POST /api/admin/notifications, GET /api/admin/feedback, GET /api/admin/audit.
