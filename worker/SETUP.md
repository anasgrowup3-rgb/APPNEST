# APPNEST Cloudflare Worker setup

The implementation retains the existing static HTML/CSS/JavaScript Mini App, Cloudflare Worker, D1, private R2 and the existing Python Telegram bot. No production resources are created or changed by this repository patch.

## Required Cloudflare bindings and secrets

Configure these on the existing Worker in the Cloudflare dashboard (or in the existing Wrangler configuration after creating real resources):

- D1 binding **DB** — the APPNEST database.
- R2 bucket binding **FILES** — private bucket only. Do not enable public development URLs or a public custom domain.
- Secret **BOT_TOKEN** — Telegram bot token; never commit it.
- Variable **ADMIN_IDS** — comma-separated numeric Telegram administrator IDs.
- Variable **ALLOWED_ORIGIN** — exact HTTPS origin of the Mini App. Do not use `*` in production.
- Optional **MAX_APK_BYTES** — maximum multipart APK size, default 2 GiB.
- Optional **MAX_DIRECT_APK_BYTES** — legacy single-request upload limit, default 16 MiB.
- Optional **TELEGRAM_AUTH_MAX_AGE** — Telegram initData maximum age in seconds, default 86400.

The repository's `worker/wrangler.jsonc` includes an hourly cleanup Cron trigger and deliberately does not contain fabricated D1 database IDs or R2 bucket names. Add the actual identifiers once the resources exist. The binding names must remain exactly `DB` and `FILES`.

## Migrations

Back up D1 before applying migrations. Both migrations are additive and do not delete existing application/user rows. Wrangler tracks applied migrations; do not run the ALTER TABLE migration manually a second time.

From the `worker` directory, apply them to the intended database:

```sh
npx wrangler d1 migrations apply <YOUR_DATABASE_NAME> --remote
```

- `migrations/0001_appnest.sql` — base catalog, users, favorites, downloads, channels, ads and audit schema.
- `migrations/0002_uploads_ads.sql` — multipart session/part tracking, per-user ad frequency and persisted language; seeds the existing four categories.

The migration smoke test uses an in-memory SQLite database and verifies that an existing user row survives both migrations. It is not a substitute for applying migrations to the actual Cloudflare D1 database.

## Resumable APK and media uploads

The admin UI uses R2 multipart uploads. R2 part size is 8 MiB; failed parts are retried up to three times. An admin can retry a failed form upload. The Worker checks ownership/expiry, part ordering, total object size, ZIP signature and a server-computed streaming SHA-256 before saving APK metadata. Large APK bytes are streamed into R2 and hashed as a stream rather than buffered in Worker memory.

- `POST /api/admin/uploads` — create upload session. JSON includes `kind`, `filename`, `size_bytes`, `content_type`, optional `app_id`, version metadata and new-app `metadata`.
- `PUT /api/admin/uploads/:id/parts?part_number=N` — stream one raw 8 MiB part.
- `POST /api/admin/uploads/:id/complete` — validate and finalize.
- `DELETE /api/admin/uploads/:id` — abort an open multipart upload.

Kinds: `apk`, `icon`, `banner`, `screenshot`. Images are limited to 10 MiB and are signature-checked as PNG/JPEG/WebP. APKs default to 2 GiB; the R2 multipart API supports larger objects subject to the configured limit and Cloudflare service constraints. The legacy `POST /api/admin/apps` endpoint remains for compatibility but is capped at 16 MiB and is not used by the new UI.

APK updates append an `app_versions` row and switch the app's current APK key only after successful completion. New apps remain drafts until media upload completes and the admin UI publishes them. Previous APK objects are retained for version history.

## Download and subscription security

- The R2 bucket must remain private; never attach a public URL to an APK object.
- APK downloads stream through the Worker only after Telegram initData validation and successful `getChatMember` checks.
- Telegram API failures deny the download (fail closed).
- The bot must be an administrator in each required channel.
- SHA-256 and ZIP structure signatures provide integrity/type checks, not a malware verdict or guarantee that an APK is safe to install.
- Do not bypass subscription verification by exposing the R2 bucket.

## Ads

Active campaigns are returned from `GET /api/ads`. The Mini App marks ad cards as **Реклама** and records impression/click events. A D1 per-user/per-campaign daily counter caps impressions at three per day. Admins can create, enable, disable and remove campaigns.

## Python Telegram bot

The existing bot continues to use its own SQLite database at `data/apps.db`; this change does not migrate or merge that catalog with D1. Set `WEBAPP_URL` in the bot's private `.env` to the deployed HTTPS Mini App URL. The bot then displays an **Открыть APPNEST** Web App keyboard and supports `/open` and `/catalog`. Do not commit `.env`.

## Scheduled cleanup\n\nThe Worker runs an hourly scheduled handler. It aborts expired open R2 multipart uploads, marks their sessions failed, deletes expired/consumed download tickets and old rate-limit/ad-frequency rows, and prunes completed/aborted/failed upload-session metadata older than 30 days. It does not delete APK/media objects or application/user records.\n\n## Tests

From `worker`:

```sh
npm test
python -m unittest discover -s test -p '*_test.py' -v
```

The GitHub Actions workflow also checks Worker/Mini App JavaScript syntax and compiles the Python bot. Mocked route tests cover health, Telegram initData, admin authorization, catalog/media behavior, CORS preflight and streaming SHA-256. Cloudflare live integration, Telegram Bot API membership, browser-on-Android, and real R2 multipart tests require configured services and are not executed by CI.

## API route groups

Public: `GET /api/health`, `GET /api/apps`, `GET /api/categories`.

Authenticated: `GET/PATCH /api/me`, favorites, app versions, app downloads, ads/impressions/clicks, subscription status and feedback.

Admin: app metadata/status/version history, multipart uploads, categories, channels and subscription mode, campaigns, users/blocking, notifications, feedback and audit events.

No production deployment is performed by these instructions.
