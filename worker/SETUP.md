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

Install the bot dependencies with `pip install -r requirements.txt`. Copy `.env.example` to `.env` and set the real `BOT_TOKEN`, numeric `ADMIN_ID`, and deployed HTTPS `WEBAPP_URL`. The example file contains placeholders only. Keep `.env` private; it is ignored by Git.\n\nThe existing bot continues to use its own SQLite database at `data/apps.db`; this change does not migrate or merge that catalog with D1. Set `WEBAPP_URL` in the bot's private `.env` to the deployed HTTPS Mini App URL. The bot then displays an **Открыть APPNEST** Web App keyboard and supports `/open` and `/catalog`. Do not commit `.env`.

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


## Isolated real-service integration testing

Do not point this test harness at production. It creates D1 rows, an APK object, image media, channel records, ad campaigns, feedback and notifications. It intentionally leaves these fixtures in place for inspection. Use a dedicated disposable D1 database and private R2 bucket.

### Create the isolated resources

1. In Cloudflare Dashboard, open **Workers & Pages → D1 SQL Database → Create**. Name it `appnest-integration-db`. Do not select the production database. Copy its database ID.
2. Open **R2 Object Storage → Create bucket**. Name it `appnest-integration-files`. Leave public access disabled: do not enable `r2.dev`, a custom domain, or public bucket access.
3. In **Workers & Pages**, create a separate Worker named `appnest-integration-api`. Do not edit the existing `appnest-api` Worker or any Pages project.
4. Make a local copy of `worker/wrangler.integration.example.jsonc` named `worker/wrangler.integration.local.jsonc`. Replace the D1 database ID, confirm the R2 bucket name, set `ADMIN_IDS` to the dedicated test administrator's numeric Telegram ID, and set `ALLOWED_ORIGIN` to the origin that will host the separate test Mini App. Never commit the local file.
5. From the `worker` directory, apply the migrations to the disposable database and deploy only the separate integration Worker:

```sh
npx wrangler d1 migrations apply appnest-integration-db --remote --config wrangler.integration.local.jsonc
npx wrangler secret put BOT_TOKEN --config wrangler.integration.local.jsonc
npx wrangler deploy --config wrangler.integration.local.jsonc
```

When prompted for `BOT_TOKEN`, paste it directly into the terminal prompt. Do not put it in a command argument, source file, GitHub issue, chat, or commit. Confirm the deployed URL belongs to `appnest-integration-api`, not the production Worker.

### Telegram test fixtures

Create two disposable Telegram channels. Add the test bot as an administrator in both channels with permission to view members. Use three separate test user accounts:
- `APPNEST_TEST_MEMBER_ALL_ID`: joined both channels.
- `APPNEST_TEST_MEMBER_ONE_ID`: joined channel one only.
- `APPNEST_TEST_NONMEMBER_ID`: joined neither channel.
- `APPNEST_TEST_ADMIN_ID`: separate test administrator ID; add it to Worker `ADMIN_IDS`.

The test harness creates cryptographically HMAC-signed Telegram initData payloads from the bot token so that authenticated API paths can be exercised. These are synthetic signed fixtures, not Telegram-client-issued initData. The subsequent `getChatMember` requests are real Telegram Bot API requests for the three configured Telegram accounts. To prove real WebView-issued initData, open the separate test Mini App from Telegram and perform the additional manual check described below.

### Run the integration suite

Set these variables in a private local `.env.integration` file (which is ignored by Git):

```dotenv
APPNEST_TEST_BASE_URL=https://YOUR-INTEGRATION-WORKER.workers.dev
APPNEST_TEST_BOT_TOKEN=YOUR_BOT_TOKEN
APPNEST_TEST_ADMIN_ID=YOUR_TEST_ADMIN_ID
APPNEST_TEST_MEMBER_ALL_ID=YOUR_USER_JOINED_TO_BOTH_CHANNELS
APPNEST_TEST_MEMBER_ONE_ID=YOUR_USER_JOINED_TO_CHANNEL_ONE_ONLY
APPNEST_TEST_NONMEMBER_ID=YOUR_USER_JOINED_TO_NEITHER_CHANNEL
APPNEST_TEST_CHANNEL_ONE_ID=-1001234567890
APPNEST_TEST_CHANNEL_ONE_URL=https://t.me/YOUR_TEST_CHANNEL_ONE
APPNEST_TEST_CHANNEL_TWO_ID=-1001234567891
APPNEST_TEST_CHANNEL_TWO_URL=https://t.me/YOUR_TEST_CHANNEL_TWO
```

Run:

```sh
cd worker
node --env-file=../.env.integration test/real-integration.mjs
```

The script verifies real Worker HTTP requests, D1 CRUD, channel membership via Telegram, all/any subscription behavior, two-part 9 MiB+ multipart create/part retry/abort/complete, server SHA-256, published media, version history, download ticket single-use behavior, campaign analytics/frequency cap, feedback, notifications and admin authorization. The APK fixture has a ZIP local-file signature and deterministic bytes; it is an integrity/API fixture, not a valid installable APK or malware scan.

The script leaves all fixtures in the disposable database and bucket. After evidence is collected, delete the dedicated integration Worker, D1 database and R2 bucket in Cloudflare Dashboard. Do not run cleanup commands against production.

### Real browser and Telegram WebView acceptance

The Mini App API endpoint is configured by the `meta[name="appnest-api-base"]` element in `miniapp/index.html`; the checked-in value remains the existing production endpoint. For an isolated preview, override only that meta value in a separate preview copy to `https://YOUR-INTEGRATION-WORKER.workers.dev/api`. Do not open the existing production Mini App and do not change the production Pages project for this test. Create a separate Cloudflare Pages project from this branch and set the integration Worker `ALLOWED_ORIGIN` to that Pages preview origin. Open the preview in Android Chrome, then open the same preview URL through a Telegram bot Web App button. Verify the real `Telegram.WebApp.initData`, RU/TJ/EN switching, catalog, app details, subscription gate, download, favorites, profile, upload progress/retry, and admin screens. Do not use production APKs or production user accounts.

### What this does not prove

- The synthetic HMAC fixtures validate Worker signature checking, but they do not replace a live Telegram client session test.
- R2 bucket privacy must also be confirmed in Cloudflare Dashboard: public access disabled and no public custom domain. The HTTP checks prove that the Worker does not expose the APK through its media route and that downloads use one-time tickets.
- A passing integration suite does not certify APK malware safety, Google Play compatibility, or installability.
- Browser/Android WebView checks require a real Android device and the separate Pages preview.


## Release checklist (must be completed before production)

- [ ] Review the open PR diff and confirm the intended branch is `feat/appnest-stable-api`.
- [ ] Run the GitHub Actions validation workflow; all syntax, Node Worker and Python/SQLite jobs must pass.
- [ ] Apply D1 migrations to a disposable integration database first; inspect the migration history and verify existing rows remain intact before any production migration.
- [ ] Run `node --env-file=../.env.integration test/real-integration.mjs` against the isolated Worker, private R2 bucket and disposable Telegram channels only.
- [ ] Verify the integration Worker bindings are exactly `DB` and `FILES`; confirm the R2 bucket has public access disabled and no public custom domain.
- [ ] Verify Telegram bot is an administrator in every required test channel and that live `getChatMember` returns the expected membership matrix.
- [ ] Open the isolated Pages preview in Android Chrome and Telegram WebView; verify initData, navigation, media, upload retry, download ticket, subscription gate, and all three locales.
- [ ] Check the deployed integration URL, allowed origin, bot identity and D1/R2 resource names before running any integration script. Never use production endpoints or secrets in the test harness.
- [ ] Review security headers, CORS, rate limits, admin authorization, file signatures, SHA-256, single-use download tickets and logs for accidental secrets.
- [ ] Confirm a backup and rollback plan for any eventual production D1 migration; keep additive migrations and retain previous Worker version for rollback.
- [ ] Obtain explicit release authorization before production deployment or merge. This PR must remain Draft/open until that authorization is given.

The real integration script is intentionally destructive only to the extent that it creates test fixtures and R2 objects in its configured target. It does not automatically delete them. Never run it unless the target is positively verified as the isolated `appnest-integration-api`, `appnest-integration-db`, and `appnest-integration-files`.
