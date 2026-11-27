# APPNEST — Product Master Plan

**Updated:** 2026-11-27  
**Repository:** `anasgrowup3-rgb/APPNEST` · **Default branch:** `main`  
**Product:** Telegram Mini App for discovering and downloading Android APK applications.

This document is the canonical product scope, technical reference, verification record, and release checklist. Keep planned, implemented, tested, and production-verified states separate. Never mark a feature complete based only on source code existing.

## 1. Product goal and non-negotiable decisions

APPNEST is a Telegram Mini App catalogue for Android applications. It is not a Google Play wrapper and does not distribute apps through Google Play. The Mini App stores app metadata in Cloudflare D1 and APK/media objects in Cloudflare R2. Android users download APKs and install them using Android's own package installer.

Core decisions:

- Telegram Mini App is the main product interface; the Telegram bot is the entry point and can support channel-membership checks.
- APK binaries are stored in R2, not sent as Telegram bot attachments.
- Preserve all existing production records and legacy tables. New APPNEST functionality uses the isolated `appnest_*` schema.
- Do not seed fake apps, fake download counts, invented ratings, placeholder APKs, or made-up source links.
- Verify the original source, package ID, version, permissions, file integrity, and redistribution rights before publishing an APK.
- Never expose bot tokens, admin credentials, password hashes, recovery-code plaintext, private R2 credentials, or raw Telegram init data.
- All admin endpoints must authorize on the server, not only hide controls in the UI.
- A feature is not production-complete until its real acceptance checks pass. CI unit tests are not proof that Telegram WebView, production D1, or R2 works end to end.

## 2. Architecture and connected resources

| Layer | Resource | Purpose |
|---|---|---|
| Source | `anasgrowup3-rgb/APPNEST` | GitHub repository |
| Frontend | `appnest-web` Worker | Serves the Mini App frontend |
| API | `appnest-api` Worker | Authentication, catalogue, admin, ads, uploads and downloads |
| Production database | `appnest-db` | Bound to `appnest-api` as `DB` |
| Production object storage | `appnest-files` | Bound to `appnest-api` as `FILES` |
| Integration API | `appnest-integration-api` Worker | Isolated end-to-end test target |
| Integration database | `appnest-integration-db` | Bound to integration Worker |
| Integration storage | `appnest-integration-files` | Isolated R2 test bucket |

The production API binding was inspected on 2026-11-27. The API Worker has `DB`, `FILES`, `ADMIN_IDS`, `ALLOWED_ORIGIN`, and a secret `BOT_TOKEN` binding. Secret values must never be copied into this document or logs.

The integration Worker has separate D1 and R2 resources. Never run destructive or test-data operations against production resources.

## 3. Current verified state (2026-11-27)

### Repository and CI

- Current `main` commit at inspection: `393cbdd8e1a7be491360d03dbc791af8e37fd1f6`.
- Previous `main` run inspected: `APPNEST validation`, run `45443270158`, completed successfully on 2026-11-24.
- Current change-branch run: `APPNEST validation`, run `45927391825`, completed successfully on 2026-11-27.
- Current branch CI passed JavaScript syntax checks, **45 Worker tests**, and **19 Python tests** (bot security, frontend static acceptance, and migration smoke tests).
- The migration smoke test uses an in-memory SQLite database. It proves that the checked-in SQL files apply together in that test database; it does not prove that the production D1 database has an identical legacy schema.
- `worker/test/real-integration.mjs` exists for the isolated integration Worker. It requires dedicated test Telegram accounts, two test channels, and integration environment variables. Do not claim it passed unless it is actually run and its result is recorded.

### Catalogue and users

- Production `appnest_apps` currently contains **0 apps**. The public catalogue must remain honestly empty until real APKs are reviewed and published.
- Production D1 has one user record at the time of inspection.
- No production app upload session or download token was present at the time of inspection.
- Required subscription channels are not yet configured for production.
- Admin access is configured through the Worker environment. Do not copy administrator IDs or recovery secrets into documentation.

### Production and integration D1

- Production database: `appnest-db`.
- Integration database: `appnest-integration-db`.
- Both databases contain the APPNEST operational tables used by the current Worker, including `appnest_apps`, `appnest_ad_campaigns`, `appnest_ad_frequency`, `appnest_upload_sessions`, `appnest_download_tokens`, `appnest_credentials`, and `appnest_auth_sessions`.
- Production also contains pre-existing legacy tables whose names and columns differ from the original standalone migration schema. For example, the legacy `ad_campaigns` table is not the APPNEST table used by the Worker. The Worker currently reads and writes `appnest_ad_campaigns` and `appnest_ad_frequency`.
- The production database does **not** have a `d1_migrations` ledger table. Its migration history cannot be inferred from a migration log; inspect actual table definitions before any production migration.
- The integration database has a `d1_migrations` ledger. On 2026-11-27, the missing `0005_admin_recovery_codes.sql` migration was applied additively to the integration database and recorded as migration 5. The table and ledger row were then read back and verified.
- No production records were deleted or modified during this inspection.

### Migration filenames — important clarification

The checked-in migration sequence is:

1. `0001_appnest.sql`
2. `0002_uploads_ads.sql`
3. `0003_production_compat.sql`
4. `0004_standalone_accounts.sql`
5. `0005_admin_recovery_codes.sql`

There is **no** `0004_ads.sql` in the current repository, and the checked-in migration test does not request it. Upload and advertising tables are defined in `0002_uploads_ads.sql` and `0003_production_compat.sql`. Do not create a duplicate migration merely to satisfy an external or stale test command. If a local test mentions `0004_ads.sql`, identify the exact script or stale migration list that requested it.

The integration migration 5 was applied on 2026-11-27. Production has the recovery-code table, but no migration ledger; do not replay all historical migrations against production.

## 4. Official platform limits and design implications

These values were checked against official documentation on 2026-11-27. They are platform limits, not a measurement of this account's current usage or billing plan.

### Cloudflare Workers

On the Workers Free plan, the published limits include:

- 100,000 incoming Worker requests per day.
- 10 ms CPU time per HTTP request.
- 128 MB memory.
- 50 external subrequests per invocation; Cloudflare-service subrequests have a separate allowance.
- 64 environment variables/secrets per Worker.
- 64 MiB uncompressed Worker size.

The Workers Paid Standard plan has a $5/month minimum and includes 10 million requests per month and 30 million CPU milliseconds; additional usage is billed separately. Do not assume this account is on Free or Paid without checking account billing.

Design implications: cache static frontend assets, paginate catalogue queries, avoid repeated D1 reads, batch related D1 operations where appropriate, and do not make unbounded Telegram calls per request.

### Cloudflare D1

Officially published Free-plan limits include:

- Up to 10 databases per account.
- Up to 500 MB per database and 5 GB total D1 storage per account.
- 7 days of Time Travel history.
- 50 D1 query subrequests per Worker invocation.
- Maximum 2 MB per string/BLOB/table row.
- Maximum 100 bound parameters per query.
- Maximum 30 seconds for a SQL query.

D1 Free usage also has daily row-read and row-write limits. Since 2026-09-01, exceeding either daily limit causes D1 queries to fail until the daily reset or a plan upgrade. Do not invent a daily row quota when it is not confirmed from the account's current plan details.

Design implications: use indexed lookups, pagination, bounded result sets, batched writes, and avoid full-table scans on frequently used endpoints. Do not use D1 to store APK binaries.

### Cloudflare R2

For R2 Standard storage, the published monthly Free tier includes:

- 10 GB-month storage.
- 1 million Class A operations.
- 10 million Class B operations.
- No egress bandwidth charge.

Above the included tier, Standard storage is $0.015 per GB-month, Class A is $4.50 per million operations, and Class B is $0.36 per million operations. Infrequent Access has different pricing, retrieval charges, and a 30-day minimum storage duration; do not choose it for frequently downloaded APKs without a cost calculation.

Design implications: keep APKs in Standard storage, use multipart upload for larger APKs, clean up abandoned multipart sessions, and issue short-lived download tickets rather than public permanent object URLs.

### Telegram Bot API

- `getChatMember` is only guaranteed to work for other users when the bot is an administrator in the target chat.
- Telegram's `ResponseParameters.retry_after` gives the number of seconds to wait after flood control. Respect this value; do not retry immediately in a tight loop.
- Telegram's FAQ broadcast limits (per-chat message rate, group messages, and bulk broadcast rate) apply to sending messages. They must not be presented as a documented fixed QPS limit for `getChatMember`.
- The Mini App must treat Telegram membership-check outages as unavailable and fail closed when a subscription gate is enabled. It must never fake a successful membership result.

## 5. Product feature scope

### Discovery and catalogue

- [ ] Home screen with featured, popular, and newest verified apps.
- [ ] Search by app name, developer, and description; debounce, empty state, error state.
- [ ] Dynamic categories and category filtering.
- [ ] Sorting by newest, most downloaded, and name.
- [ ] Pagination/infinite loading without duplicates.
- [ ] App details: title, icon, publisher, description, category, version, minimum Android, size, screenshots, changelog, source, and download count.
- [ ] Similar/recommended apps based only on verified metadata.
- [ ] Lifecycle: candidate → verified metadata → binary verified → reviewed → published; also needs-update and suspended.
- [ ] Duplicate package ID and version checks before publication.

### Accounts and personalization

- [ ] Telegram WebApp initData signature and freshness validation.
- [x] Server-side session cookies and logout/revocation logic exist in source; full browser acceptance still required.
- [ ] User profile and identity, with clear behavior outside Telegram.
- [ ] Favorites and saved apps.
- [ ] Download history.
- [ ] Feedback and report-an-app flow.
- [ ] Notifications and unread state.
- [ ] RU/TJ/EN language persistence and complete translation coverage.
- [ ] Accessibility: semantic controls, focus states, contrast, reduced motion, scalable text.

### APK uploads, versions, and downloads

- [x] Multipart R2 upload flow exists in Worker source and frontend.
- [x] Upload sessions and parts are stored in D1.
- [x] Server-side SHA-256 verification exists in Worker source.
- [x] Download tickets are short-lived and single-use in Worker source.
- [ ] Verify real APK package name, version code, minimum Android, and permissions before publication.
- [ ] Add complete version history and release notes UX.
- [ ] Verify upload/replace/retry/abort and download round trip on the isolated integration Worker.
- [ ] Confirm safe MIME type, filename, content length, and cache headers on a real Android device.
- [ ] Never expose arbitrary R2 keys or permanent public APK URLs.
- [ ] Never host malware, pirated, modified, or unlicensed binaries.

### Admin console

- [x] Server-side admin checks and audit-log writes exist in Worker source.
- [x] Admin category, channel, app, upload, and advertisement API routes exist in Worker source.
- [ ] Verify Telegram admin login in the real Telegram WebView.
- [ ] Dashboard metrics and pending-review queue.
- [ ] Create/edit app metadata and categories.
- [ ] Upload/replace icons, banners, screenshots, and APKs.
- [ ] Review, publish, unpublish, suspend, and archive controls.
- [ ] Version management and changelog.
- [ ] Required-channel management and all/any subscription mode.
- [ ] Advertisement campaign manager with schedule, priority, and active state.
- [ ] Notification composer and feedback moderation.
- [ ] Audit-log viewer and safe export.
- [ ] Settings and maintenance mode; confirmation for destructive actions.

### Telegram integration and membership checks

- [ ] Bot menu button opens the canonical HTTPS Mini App URL; verify in Telegram.
- [ ] /start and deep-link launch handling.
- [ ] Bot is administrator in every channel used for membership checks.
- [x] Membership check uses `getChatMember` and supports all/any channel logic in source.
- [x] The Worker fails closed when Telegram is unavailable.
- [x] Bounded retry for Telegram 429 using `retry_after`; one retry for transient 5xx/network errors; regression tests pass in CI. Real Telegram channel checks remain unverified.
- [ ] Subscription gate has a clear recheck action and useful unavailable state.
- [ ] Do not repeatedly call Telegram's menu-button method after HTTP 429. Wait for the returned retry interval and make one controlled attempt.
- [ ] Verify WebApp `ready()`, `expand()`, theme/viewport integration, BackButton, and MainButton where useful.

### Advertising and growth

- [x] Admin-managed ad campaign create/update/delete API routes exist in Worker source.
- [x] Active ad retrieval and per-user daily impression caps exist in Worker source.
- [ ] Verify impression/click accounting and caps in integration tests.
- [ ] Clearly label ads; no deceptive download buttons or forced redirects.
- [ ] Keep sponsored placement visually separate from organic ranking.
- [ ] Rewarded tasks only if transparent and policy-compliant; membership checks must never be faked.
- [ ] Referral attribution only with privacy disclosure and abuse controls.

### Reliability, security, and operations

- [ ] Verify CORS allowlist against the actual canonical frontend origin.
- [x] Parameterized SQL is used in the inspected Worker routes.
- [x] API authentication and rate-limit checks exist in source.
- [ ] Add/verify rate limits for public, authenticated, upload, and admin routes.
- [ ] Standardize JSON envelopes and stable error codes.
- [ ] Keep production migration history documented because production D1 has no `d1_migrations` table.
- [ ] Keep migrations additive; do not replay legacy migrations against production without a schema diff and backup.
- [ ] R2 cleanup for abandoned multipart uploads.
- [ ] Health endpoint and scheduled cleanup.
- [ ] Structured logs without tokens or personal secrets.
- [ ] D1 backup/export and R2 object-inventory recovery plan.
- [x] CI checks Worker syntax, Worker tests, frontend static checks, bot security checks, and migration smoke tests.
- [ ] Run isolated real integration tests and production smoke tests.
- [ ] Document rollback steps before production deployment.

### UI quality

- [ ] Mobile-first layout and Telegram safe-area handling.
- [ ] Skeleton, empty, offline, retry, and error states for every data view.
- [ ] Consistent icons, image fallbacks, aspect ratios, and screenshot gallery.
- [ ] No emoji-only app artwork; use real app icons/screenshots.
- [ ] Reduced-motion support, no layout shifts, no horizontal overflow.
- [ ] Loading and download progress feedback.
- [ ] Verify the actual rendered Mini App on Android Telegram, not only static HTML checks.

## 6. Release gates

Do not announce APPNEST as production-ready until all of these pass:

1. Canonical HTTPS frontend opens in Telegram WebView.
2. Bot menu button launches the Mini App.
3. Telegram identity and admin authorization are verified server-side.
4. Production catalogue, search, categories, and details work against production D1.
5. Favorites, history, feedback, notifications, and admin flows work end to end.
6. APK upload completes to R2, server hash matches, and the APK metadata is checked.
7. Download ticket is short-lived, single-use, and streams the correct APK.
8. Subscription checks pass against real test channels and recover safely from Telegram 429/5xx.
9. Ads are labelled, scheduled, tracked, and frequency-capped.
10. RU/TJ/EN coverage is complete.
11. Security, migration, regression, and integration tests pass.
12. Production smoke test and rollback path are recorded.

## 7. Work log

### 2026-11-27 — migration and platform audit

- Inspected the GitHub tree and confirmed that the current migration files are 0001 through 0005. No `0004_ads.sql` exists or is referenced by the checked-in migration smoke test.
- Read the migration smoke test: it explicitly applies `0001_appnest.sql`, `0002_uploads_ads.sql`, `0003_production_compat.sql`, `0004_standalone_accounts.sql`, and `0005_admin_recovery_codes.sql`.
- Queried production and integration D1 directly. Confirmed the APPNEST tables used by the Worker exist in production. Found that the integration database was missing the recovery-code migration and its migration-ledger entry.
- Applied the additive `0005_admin_recovery_codes.sql` schema to the integration database and inserted the matching migration-ledger row. Re-read both the table and ledger to verify the change. No production data was changed.
- Confirmed the latest existing CI run passed 42 Worker tests and 19 Python tests. These tests are not a substitute for the isolated live integration test.
- Read the official Cloudflare Workers, D1, and R2 limits and the official Telegram Bot API `getChatMember` and `retry_after` documentation.
- Found that `subscriptionCheck()` treated Telegram HTTP 429/5xx as unavailable without respecting `retry_after` or retrying transient errors. Added bounded retry handling and three regression tests on branch `fix/telegram-retry-and-plan-20261127`.
- GitHub Actions run `45927391825` passed: syntax checks, 45 Worker tests, and 19 Python tests. No production Worker deployment was made.
- Production catalogue remains empty. No fake apps were inserted.

### 2026-11-24 — APPNEST 2.0 visual redesign

- Reworked home discovery hierarchy, hero copy, catalogue CTA, category/popular/recent labels, and the graphite/acid-mint design system.
- Updated header, hero, cards, category tiles, controls, profile surfaces, navigation, modal, empty states, and responsive mobile sizing.
- Frontend changes were committed in the repository.
- Production frontend deployment was updated previously; verify the current public URL in a normal browser and Telegram before release.
- Limitation: a user-reported Pages URL returned 404. Do not repeat identical Pages uploads as a workaround.

### 2026-11-24 — production hardening and admin login

- Worker source was updated previously to give verified Telegram initData for a configured administrator precedence over an existing guest/non-admin cookie.
- API path normalization was adjusted to tolerate a duplicated `/api` prefix.
- Production Worker deployment and bindings were previously updated. Re-verify live behavior before claiming the current code is deployed.
- Telegram menu-button setup previously returned HTTP 429. Do not repeat the same call without respecting Telegram's retry interval.
- Limitation: public HTTP/Telegram WebView smoke tests were not completed in that session.
