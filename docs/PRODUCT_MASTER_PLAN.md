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
- Worker and Pages deployments were attempted. Pages returned 404 in user testing; Worker-hosted frontend route was discussed but must be independently smoke-tested before considered canonical.
- Telegram menu-button setup returned HTTP 429 with retry_after; stop repeated requests until cooldown passes, then perform one controlled attempt.
- Production catalogue currently has 0 apps. Do not present placeholder content as real published apps.
- Menu-button URL and frontend/API origin alignment must be verified before launch.

## Work log
Append dated entries with: change, files/resources changed, tests run, result, known limitation, next concrete action.
