# APPNEST Release Checklist

This checklist is a release gate, not a statement that production is currently approved.

## Repository and CI

- [ ] The reviewed source is the latest `feat/appnest-stable-api` commit.
- [ ] Existing PR #1 is open and Draft while work is under review.
- [ ] GitHub Actions passes JavaScript/Python syntax checks, Worker tests and SQLite migration/frontend acceptance tests.
- [ ] No secrets, local Wrangler files, test credentials or integration environment files are committed.

## Cloudflare isolation and data

- [ ] Verify the test Worker is `appnest-integration-api`, bound only to `appnest-integration-db` (D1 binding `DB`) and private `appnest-integration-files` (R2 binding `FILES`).
- [ ] Confirm the R2 bucket has public access disabled and no public custom domain.
- [ ] Apply migrations to the disposable D1 database and inspect the migration history.
- [ ] Run `cd worker && node --env-file=../.env.integration test/real-integration.mjs` with test-only credentials.
- [ ] Confirm real multipart create/part retry/complete/abort, object size, ZIP signature, server SHA-256, image media, and one-time APK ticket download.
- [ ] Confirm no test command targets the production Worker, Pages project, D1 or R2.

## Telegram

- [ ] Use a test bot token only in the private local environment or protected CI secrets.
- [ ] Confirm the bot is an administrator in both disposable test channels.
- [ ] Verify live `getChatMember` for joined-both, joined-one and joined-none test accounts in both `all` and `any` modes.
- [ ] Verify fail-closed behavior when Telegram is unavailable.
- [ ] Open the isolated Mini App from a real Telegram client and confirm the client-issued `Telegram.WebApp.initData` is accepted; synthetic HMAC test fixtures do not prove this.

## User interface

- [ ] Open the isolated Pages preview in Android Chrome at small and standard phone viewports.
- [ ] Open the same preview through Telegram WebView and check safe areas, theme, back navigation, modals, touch targets and keyboard behavior.
- [ ] Verify catalog, search, categories, details, media, versions, favorites, history, profile, feedback, notifications and subscription-gated downloads.
- [ ] Verify all admin panels and every visible control: apps, categories, versions, uploads, channels, campaigns, users, feedback, notifications, audit and analytics.
- [ ] Verify Russian, Tajik and English across static and dynamically rendered UI, including error and empty states.
- [ ] Verify multipart progress, retry on the same selected file, and expired-session recovery on a deliberately interrupted test upload.

## Security and reliability

- [ ] Verify all admin routes reject missing/invalid Telegram auth and non-admin identities.
- [ ] Verify blocked users, rate limits, CORS origin restrictions and fail-closed Telegram membership checks.
- [ ] Verify cross-user upload-session access is denied.
- [ ] Verify arbitrary R2 keys and direct APK object paths are not publicly readable.
- [ ] Verify download tickets are short-lived and single-use.
- [ ] Verify request/file limits, content-type/signature checks, and server-computed SHA-256.
- [ ] Review logs and responses for tokens, secrets, internal stack traces or private object keys.
- [ ] Confirm APK validation is described as integrity/type checking only; it is not malware scanning or a safety verdict.

## Production authorization (separate approval required)

- [ ] Back up production D1 and document a rollback plan before any migration.
- [ ] Review the exact production bindings, Worker variables/secrets, allowed origin, Telegram bot and R2 privacy configuration.
- [ ] Obtain explicit user authorization before merging PR #1 or deploying Worker/Pages.
- [ ] Keep production unchanged until the explicit authorization is received.

## Current known limits

The repository CI runs local Worker handler tests and SQLite migration tests; it does not prove Cloudflare service integration. The real-service script requires a configured isolated Worker, D1, private R2 bucket, Telegram bot token and disposable Telegram channel/member fixtures. Android Chrome and Telegram WebView acceptance require a real device/client. No malware scanning service is included.
