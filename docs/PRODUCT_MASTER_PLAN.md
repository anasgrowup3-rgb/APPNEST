# APPNEST — Product Master Plan

This file is the canonical product scope and release checklist. Update it whenever a feature is added, deferred, implemented, or verified. Do not silently drop items between sessions.

## Product goal
A polished Telegram Mini App for discovering, reviewing, and downloading Android applications. Frontend: static HTML/CSS/vanilla JS. Backend: Cloudflare Worker. Data: Cloudflare D1. Files: Cloudflare R2. Telegram bot provides the launch entry point and membership checks.

## Non-negotiable release principles
- Preserve existing production data and legacy tables; all new APPNEST data uses isolated appnest_* tables.
- Never publish an APK unless its source, package identity, version, permissions, and integrity have been checked. Never invent download links, app descriptions, ratings, or compatibility claims.
- Never expose BOT_TOKEN, admin credentials, private R2 keys, or Telegram init data.
- Downloads must use short-lived, single-use tokens and server-side authorization.
- Admin actions must be authenticated, rate-limited, and audit logged.
- User-facing errors must be understandable; do not show raw stack traces.
- Do not count a feature as complete until its acceptance checks pass in a real Telegram WebView where applicable.

## Feature inventory
### Discovery and catalogue
- [ ] Home screen with featured area, popular and newest apps.
- [ ] Search by app name, developer, and description; debounced input and empty/error states.
- [ ] Categories and category filtering.
- [ ] Sorting: newest, most downloaded, name; pagination/infinite loading without duplicates.
- [ ] App detail: title, icon, developer, description, version, minimum Android, file size, screenshots, changelog, download count.
- [ ] Similar/recommended apps.
- [ ] App lifecycle: draft → review → published → suspended/archived.
- [ ] Content quality checks and duplicate package detection before publishing.

### Accounts and personalization
- [ ] Telegram WebApp initData signature validation and freshness check.
- [ ] User profile and Telegram identity; graceful fallback outside Telegram.
- [ ] Favorites and saved apps; download history.
- [ ] User feedback/report an app.
- [ ] Notifications and unread state.
- [ ] RU/TJ/EN language support; persistent preference and complete translated strings.
- [ ] Accessibility: semantic controls, focus states, contrast, reduced motion, scalable text.

### Downloads and file integrity
- [ ] Admin APK upload with multipart R2 upload, resumability, size limits, and expiry cleanup.
- [ ] Server-side SHA-256 computation/verification.
- [ ] Version history and release notes.
- [ ] One-time, expiring download tokens; no public bucket listing or permanent object URLs.
- [ ] Correct Android MIME type, filename, content length, safe cache headers.
- [ ] Download failure/retry UX and duplicate-tap protection.
- [ ] APK package/version metadata verification before publication.
- [ ] Never host modified, pirated, malware, or unlicensed binaries.

### Admin console
- [ ] Admin authorization by Telegram user ID, server-side checks on every admin route.
- [ ] Dashboard metrics: users, published apps, downloads, pending submissions, reports.
- [ ] Create/edit app metadata and categories.
- [ ] Upload/replace icon, banner, screenshots, APK.
- [ ] Review queue and publish/unpublish/suspend controls.
- [ ] Version management and changelog.
- [ ] Required-channel management and subscription mode (all/any).
- [ ] Advertisement campaign manager and schedule/priority controls.
- [ ] Notification composer; feedback/report moderation.
- [ ] Audit log viewer and safe export.
- [ ] Settings and maintenance mode; confirm destructive actions.

### Telegram integration
- [ ] Bot menu button opens canonical HTTPS Mini App URL.
- [ ] Optional /start deep-link and launch handling.
- [ ] Bot is administrator in each required channel when membership verification is enabled.
- [ ] getChatMember handles Telegram 429/5xx with retry_after, bounded retries, and no tight retry loops.
- [ ] Subscription gate has clear recheck action and useful unavailable state.
- [ ] Set menu button only after rate limit clears; use one controlled call and verify result.
- [ ] WebApp ready(), expand(), theme/viewport integration, BackButton and MainButton where useful.

### Advertising and growth
- [ ] Admin-managed ad campaigns with creative, target URL, schedule, priority, active flag.
- [ ] Frequency caps per user/day and impression/click tracking.
- [ ] Clearly label ads; no deceptive download buttons or forced redirects.
- [ ] Optional sponsored app placement separated from organic ranking.
- [ ] Optional rewarded tasks only if transparent and policy-compliant; subscription checker must never fake membership.
- [ ] Referral/deep-link attribution only with clear privacy disclosure and abuse controls.

### Reliability, security, and operations
- [ ] CORS allowlist limited to canonical frontend origins.
- [ ] Strict input validation, SQL parameterization, output encoding, file-type/size validation.
- [ ] Rate limits for public, authenticated, upload, and admin endpoints.
- [ ] Consistent JSON API envelope and stable error codes.
- [ ] D1 foreign-key checks and migration history; production migrations additive and reversible where practical.
- [ ] R2 cleanup for abandoned multipart uploads.
- [ ] Health endpoint and scheduled cleanup.
- [ ] Structured logs without tokens or personal secrets.
- [ ] Backup/export plan for D1 metadata and R2 object inventory.
- [ ] CI tests for Worker logic, migrations, API contracts, frontend smoke checks.
- [ ] Production smoke test after every deploy; rollback instructions documented.

### UI quality
- [ ] Mobile-first layout and Telegram safe-area handling.
- [ ] Skeleton, empty, offline, retry, and error states for every data view.
- [ ] Consistent icons, image fallbacks, aspect ratios, and screenshot gallery.
- [ ] No emoji-only app artwork; use real app icons/screenshots.
- [ ] Reduced motion support, no layout shifts, no horizontal overflow.
- [ ] Loading and download progress feedback.

## Content policy and catalogue workflow
Every app record must include: canonical app name, developer/publisher, category, short summary, full description, package/application ID (when available), current version, version code, minimum Android, file size, original source URL, license/distribution permission status, SHA-256, icon source, screenshot sources, review status, and last verification date.

Content states: candidate → verified_metadata → binary_verified → reviewed → published. Also support needs_update and suspended. Do not seed fabricated apps or placeholder APKs into the public catalogue. Prepare candidate lists separately, then publish only after source and binary verification. Prefer official developer websites and reputable authorized distribution sources. Record attribution and license notes.

Initial categories: Productivity, Games, Tools, Other.

## Release gates
- [ ] Main frontend opens from canonical HTTPS address.
- [ ] Telegram bot menu launches Mini App in Telegram WebView.
- [ ] Telegram identity is validated; unauthorized API requests are rejected.
- [ ] Catalogue/search/category/detail flows work against production D1.
- [ ] Favorites, history, feedback, notifications, and admin flows are tested.
- [ ] Upload/download round trip works with R2 and hash verification.
- [ ] Subscription checks work with a real test channel and recover from Telegram rate limits.
- [ ] Ads are frequency-capped and clearly labeled.
- [ ] RU/TJ/EN coverage is checked.
- [ ] Security, migration, and regression tests pass.
- [ ] Production smoke test and rollback path are recorded.

## Current known state (2026-11-24)
- Repository: anasgrowup3-rgb/APPNEST, default branch main.
- Worker: appnest-api; production D1 and R2 bindings are configured.
- Production compatibility migration 0003_production_compat.sql created isolated appnest_* tables; legacy tables preserved.
- Earlier static SQL validation passed for 95 SQL statements; CI previously passed 30 Worker tests + 19 migration tests.
- Pages project appnest still has a user-reported 404; repeated identical Pages uploads are not a valid fix.
- Worker-hosted frontend appnest-web is deployed at 100% traffic, workers.dev subdomain is enabled, and its embedded index.html/script.js/style.css were byte-for-byte compared with the current GitHub frontend (index.html uses the same-origin /api proxy). Its API proxy targets appnest-api. External HTTP smoke testing is still required because this execution environment blocks requests to the app's public hostnames.
- Production API Worker was re-deployed from the exact GitHub main source. The temporary public __bot_setup route (which contained a query-key gate in source) is removed. D1, R2, ADMIN_IDS, ALLOWED_ORIGIN, and the BOT_TOKEN secret binding were verified unchanged.
- Telegram menu-button setup previously returned HTTP 429; do not repeat until Telegram's rate limit has cleared, then make one controlled attempt using the appnest-web URL.
- Production catalogue currently has 0 apps and no required subscription channels. Do not present placeholder content as real published apps.
- External browser smoke test, Telegram WebView/menu button, real subscription check, and APK upload/download round trip remain release gates.

## Work log
Append dated entries with: change, files/resources changed, tests run, result, known limitation, next concrete action.

### 2026-11-24 — APPNEST 2.0 visual redesign
- Reworked the home discovery hero copy and hierarchy, added a clear catalogue CTA, a three-step product strip, and updated category/popular/recent section labels.
- Replaced the old purple-black palette with a distinct graphite and acid-mint design system; refreshed header, hero orb, cards, category tiles, controls, profile surfaces, navigation, modal, empty states, and responsive mobile sizing.
- Committed frontend changes: `miniapp/index.html` commit `8feed4af4fa3fc01f96b9be2abe7e920f1ad8ead`; `miniapp/style.css` commit `85ad617ff0b50f1df95cf98f42f4108e1c4f23fd`.
- Published the updated embedded frontend to Worker `appnest-web`; new deployment `ea440a48-b49b-4757-9ad5-60d7786d026b`, version `097b85ee-e90a-48ef-9dff-284984c360ad`, 100% traffic.
- Verified embedded HTML/CSS/JS exactly match current GitHub files (HTML API base intentionally set to same-origin `/api`); JS syntax check passed; CSS brace balance is zero; 67 HTML IDs with no duplicates; key UI IDs are present.
- Limitation: public browser rendering still needs a device-side check; direct external HTTP is blocked in this execution environment. The previous Pages URL is not the updated Worker-hosted frontend URL.


### 2026-11-24 — production hardening and three-pass verification
- Change: replaced the production `appnest-api` Worker content with the exact `worker/src/index.js` from main; removed the temporary `__bot_setup` route. Verified that the production D1 and R2 bindings, `ADMIN_IDS`, `ALLOWED_ORIGIN`, and `BOT_TOKEN` secret binding remained intact.
- Frontend: verified the deployed `appnest-web` Worker has a 100% traffic deployment and enabled workers.dev subdomain. Compared its embedded HTML, JS, and CSS against the current repository files; all three matched (HTML differs only by the expected same-origin `/api` base URL). Confirmed its `/api` proxy points to `appnest-api`.
- Tests: confirmed the latest APPNEST validation workflow run on commit `d1b94130d381af054f5daa5fefa155679f11a8d8` completed successfully; prior CI covers 30 Worker tests and 19 migration tests. Recomputed all three Pages deployment asset SHA-256 values; each matches the corresponding GitHub frontend file.
- Result: production temporary setup route removed; Worker secrets and storage bindings preserved; Worker-hosted frontend content and routing configuration verified.
- Limitation: direct HTTP requests to public Workers/Pages hostnames are blocked in this execution environment, so browser status cannot be claimed. Pages project still has a user-reported 404; Telegram menu-button API previously returned 429. Production catalogue remains empty.
- Next: externally open `https://appnest-web.anas-grow-up-3.workers.dev/`, then complete Telegram menu-button setup after the Telegram rate limit clears; only publish apps after source, package, signing, and distribution checks.
