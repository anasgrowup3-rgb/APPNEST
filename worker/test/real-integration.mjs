import assert from "node:assert/strict";
import { createHmac, createHash, randomUUID } from "node:crypto";

const required = [
  "APPNEST_TEST_BASE_URL", "APPNEST_TEST_BOT_TOKEN", "APPNEST_TEST_ADMIN_ID",
  "APPNEST_TEST_MEMBER_ALL_ID", "APPNEST_TEST_MEMBER_ONE_ID", "APPNEST_TEST_NONMEMBER_ID",
  "APPNEST_TEST_CHANNEL_ONE_ID", "APPNEST_TEST_CHANNEL_ONE_URL",
  "APPNEST_TEST_CHANNEL_TWO_ID", "APPNEST_TEST_CHANNEL_TWO_URL"
];
for (const key of required) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);

const base = process.env.APPNEST_TEST_BASE_URL.replace(/\/+$/, "");
const botToken = process.env.APPNEST_TEST_BOT_TOKEN;
const adminId = String(process.env.APPNEST_TEST_ADMIN_ID);
const memberAll = String(process.env.APPNEST_TEST_MEMBER_ALL_ID);
const memberOne = String(process.env.APPNEST_TEST_MEMBER_ONE_ID);
const nonmember = String(process.env.APPNEST_TEST_NONMEMBER_ID);
const channels = [
  { chat_id: String(process.env.APPNEST_TEST_CHANNEL_ONE_ID), invite_url: process.env.APPNEST_TEST_CHANNEL_ONE_URL, title: "APPNEST integration channel one" },
  { chat_id: String(process.env.APPNEST_TEST_CHANNEL_TWO_ID), invite_url: process.env.APPNEST_TEST_CHANNEL_TWO_URL, title: "APPNEST integration channel two" }
];
assert.equal(new Set([adminId, memberAll, memberOne, nonmember]).size, 4, "Use four distinct test Telegram accounts");
assert.equal(new Set(channels.map(x => x.chat_id)).size, 2, "Use two distinct test channels");

function telegramInitData(id) {
  const user = { id: Number(id), first_name: "APPNEST", last_name: "Integration", username: `appnest_test_${id}` };
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `AAEAAAGintegration_${randomUUID().replaceAll("-", "")}`,
    user: JSON.stringify(user)
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

async function call(path, { userId, method = "GET", body, raw, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(userId ? { "X-Telegram-Init-Data": telegramInitData(userId) } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(raw !== undefined ? { "content-type": "application/octet-stream" } : {}),
      ...headers
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
  });
  const type = response.headers.get("content-type") || "";
  const data = type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, data, headers: response.headers };
}
function ok(result, expected, label) {
  assert.equal(result.status, expected, `${label}: expected HTTP ${expected}, received ${result.status}; body=${JSON.stringify(result.data).slice(0, 500)}`);
}
function passed(label) { console.log(`PASS  ${label}`); }

const health = await call("/api/health");
ok(health, 200, "isolated Worker health");
assert.equal(health.data.status, "online");
passed("isolated Worker is reachable");

ok(await call("/api/me"), 401, "missing Telegram auth");
ok(await call("/api/admin/overview"), 401, "missing admin auth");
ok(await call("/api/admin/overview", { userId: memberAll }), 403, "non-admin cannot access admin API");
passed("unauthenticated and non-admin requests are rejected");

const profile = await call("/api/me", { userId: memberAll });
ok(profile, 200, "create/read D1 user");
ok(await call("/api/me", { userId: memberAll, method: "PATCH", body: { language: "en" } }), 200, "update D1 user language");
const profileAfter = await call("/api/me", { userId: memberAll });
assert.equal(profileAfter.data.language, "en");
passed("D1 user create/read/update and language persistence");

const categorySlug = `it-${Date.now()}`;
ok(await call("/api/admin/categories", { userId: adminId, method: "POST", body: { slug: categorySlug, title: "Integration test", icon: "T", sort_order: 999 } }), 201, "create D1 category");
const categoryList = await call("/api/admin/categories", { userId: adminId });
ok(categoryList, 200, "read D1 categories");
const category = categoryList.data.categories.find(x => x.slug === categorySlug);
assert.ok(category, "new category is persisted");
ok(await call(`/api/admin/categories/${category.id}`, { userId: adminId, method: "PATCH", body: { title: "Integration test updated", icon: "I", sort_order: 998 } }), 200, "update D1 category");
passed("D1 category create/read/update");

for (const channel of channels) {
  ok(await call("/api/admin/channels", { userId: adminId, method: "POST", body: channel }), 201, "create isolated required channel");
}
ok(await call("/api/admin/subscription-mode", { userId: adminId, method: "PUT", body: { mode: "all" } }), 200, "set all-channel mode");
const allStatus = await call("/api/subscription/status", { userId: memberAll });
ok(allStatus, 200, "Telegram getChatMember for all-member account");
assert.equal(allStatus.data.allowed, true, "all-member account must pass all mode");
const oneInAll = await call("/api/subscription/status", { userId: memberOne });
ok(oneInAll, 200, "Telegram getChatMember for one-channel account");
assert.equal(oneInAll.data.allowed, false, "one-channel account must fail all mode");
const noneInAll = await call("/api/subscription/status", { userId: nonmember });
ok(noneInAll, 200, "Telegram getChatMember for non-member account");
assert.equal(noneInAll.data.allowed, false, "non-member account must fail all mode");
ok(await call("/api/admin/subscription-mode", { userId: adminId, method: "PUT", body: { mode: "any" } }), 200, "set any-channel mode");
assert.equal((await call("/api/subscription/status", { userId: memberOne })).data.allowed, true, "one-channel account must pass any mode");
assert.equal((await call("/api/subscription/status", { userId: nonmember })).data.allowed, false, "non-member account must fail any mode");
passed("live Telegram getChatMember: all/any subscription matrix");

const cancelled = await call("/api/admin/uploads", {
  userId: adminId, method: "POST",
  body: { kind: "apk", filename: "cancel-test.apk", size_bytes: 8, content_type: "application/vnd.android.package-archive", version: "0.0.1", version_code: 1, min_android: "7" }
});
ok(cancelled, 201, "create multipart session for abort");
ok(await call(`/api/admin/uploads/${cancelled.data.upload_id}`, { userId: adminId, method: "DELETE" }), 200, "abort R2 multipart upload");
ok(await call(`/api/admin/uploads/${cancelled.data.upload_id}/parts?part_number=1`, { userId: adminId, method: "PUT", raw: Buffer.from("12345678") }), 404, "aborted upload cannot accept parts");
passed("real R2 multipart abort and closed-session enforcement");

const apk = Buffer.alloc(8 * 1024 * 1024, 0x41);
apk.write("\x50\x4b\x03\x04", 0, "binary");
const expectedSha = createHash("sha256").update(apk).digest("hex");
const upload = await call("/api/admin/uploads", {
  userId: adminId, method: "POST",
  body: {
    kind: "apk", filename: "appnest-integration.apk", size_bytes: apk.length,
    content_type: "application/vnd.android.package-archive", version: "1.0.0",
    version_code: 100, min_android: "7.0",
    metadata: { title: "APPNEST integration fixture", description: "Disposable integration test app", developer: "APPNEST QA", category: categorySlug }
  }
});
ok(upload, 201, "create R2 APK multipart upload");
assert.equal(upload.data.part_size, 8388608);
const partPath = `/api/admin/uploads/${upload.data.upload_id}/parts?part_number=1`;
ok(await call(partPath, { userId: adminId, method: "PUT", raw: apk }), 200, "upload 8 MiB R2 part");
ok(await call(partPath, { userId: adminId, method: "PUT", raw: apk }), 200, "retry same R2 part");
const complete = await call(`/api/admin/uploads/${upload.data.upload_id}/complete`, { userId: adminId, method: "POST", body: {} });
ok(complete, 200, "complete R2 multipart APK");
assert.equal(complete.data.sha256, expectedSha, "server SHA-256 must match client digest");
const appId = complete.data.app_id;
assert.ok(appId);
ok(await call(`/api/admin/apps/${appId}`, { userId: adminId, method: "PATCH", body: { status: "published" } }), 200, "publish isolated integration app");
passed("R2 multipart retry/complete, ZIP signature and streaming SHA-256");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=", "base64");
const iconUpload = await call("/api/admin/uploads", {
  userId: adminId, method: "POST",
  body: { kind: "icon", filename: "fixture.png", size_bytes: png.length, content_type: "image/png", app_id: appId }
});
ok(iconUpload, 201, "create R2 icon multipart upload");
ok(await call(`/api/admin/uploads/${iconUpload.data.upload_id}/parts?part_number=1`, { userId: adminId, method: "PUT", raw: png }), 200, "upload icon part");
ok(await call(`/api/admin/uploads/${iconUpload.data.upload_id}/complete`, { userId: adminId, method: "POST", body: {} }), 200, "complete icon upload");
const catalog = await call("/api/apps", { userId: memberAll });
ok(catalog, 200, "read published app from D1");
const app = catalog.data.apps.find(x => x.id === appId);
assert.ok(app, "published test app is in catalog");
assert.ok(app.icon_url, "published test app exposes icon media route");
const media = await fetch(base + app.icon_url);
assert.equal(media.status, 200, "published icon must be readable");
const arbitraryMedia = await fetch(base + "/api/media/media/not-a-real-object.png");
assert.equal(arbitraryMedia.status, 404, "arbitrary R2 key must not be readable");
const apkAsMedia = await fetch(base + "/api/media/" + encodeURIComponent(complete.data.object_key));
assert.equal(apkAsMedia.status, 404, "APK key must not be exposed through public media route");
passed("published media access and APK object-key isolation");

const versions = await call(`/api/apps/${appId}/versions`, { userId: memberAll });
ok(versions, 200, "read app version history");
assert.ok(versions.data.versions.some(v => v.version_code === 100));
const history = await call(`/api/admin/apps/${appId}/versions`, { userId: adminId });
ok(history, 200, "admin version history");
assert.ok(history.data.versions.length >= 1);
passed("D1 APK version history");

const ticket = await call(`/api/apps/${appId}/download-ticket`, { userId: memberAll, method: "POST", body: {} });
ok(ticket, 200, "issue subscription-checked download ticket");
const downloadUrl = base + ticket.data.url;
const downloaded = await fetch(downloadUrl);
assert.equal(downloaded.status, 200, "single-use ticket must stream APK");
const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
assert.equal(createHash("sha256").update(downloadedBytes).digest("hex"), expectedSha);
const replay = await fetch(downloadUrl);
assert.equal(replay.status, 410, "download ticket must be one-time");
const directGuess = await fetch(base + "/api/apk/" + encodeURIComponent(complete.data.object_key));
assert.equal(directGuess.status, 404, "there must be no public APK object route");
passed("protected APK stream, digest and one-time download ticket");

const starts = new Date(Date.now() - 120000).toISOString().replace("T", " ").slice(0, 19);
const ends = new Date(Date.now() + 3600000).toISOString().replace("T", " ").slice(0, 19);
const adTitle = `APPNEST integration ad ${Date.now()}`;
const adCreated = await call("/api/admin/ads", {
  userId: adminId, method: "POST",
  body: { title: adTitle, kind: "channel", creative_url: "", target_url: "https://t.me/", starts_at: starts, ends_at: ends, active: true, priority: 999 }
});
ok(adCreated, 201, "create D1 ad campaign");
const ads = await call("/api/ads", { userId: memberOne });
ok(ads, 200, "read active ads");
const ad = ads.data.ads.find(x => x.title === adTitle);
assert.ok(ad, "active integration ad must be returned");
for (let i = 0; i < 3; i++) ok(await call(`/api/ads/${ad.id}/impression`, { userId: memberOne, method: "POST", body: {} }), 200, "record ad impression");
const fourth = await call(`/api/ads/${ad.id}/impression`, { userId: memberOne, method: "POST", body: {} });
ok(fourth, 200, "fourth ad impression is rate-limited");
assert.equal(fourth.data.limited, true);
assert.equal((await call("/api/ads", { userId: memberOne })).data.ads.some(x => x.id === ad.id), false);
passed("D1 advertising campaign, impression analytics and daily frequency cap");

ok(await call("/api/feedback", { userId: memberOne, method: "POST", body: { message: "APPNEST integration feedback fixture" } }), 201, "create user feedback");
const feedback = await call("/api/admin/feedback", { userId: adminId });
ok(feedback, 200, "admin reads feedback");
assert.ok(feedback.data.feedback.some(x => x.message === "APPNEST integration feedback fixture"));
ok(await call("/api/admin/notifications", { userId: adminId, method: "POST", body: { title: "Integration notice", message: "Disposable test notification" } }), 201, "create notification");
assert.ok((await call("/api/me", { userId: memberOne })).data.notifications.some(x => x.title === "Integration notice"));
passed("D1 feedback and notification workflows");

const adminOverview = await call("/api/admin/overview", { userId: adminId });
ok(adminOverview, 200, "admin overview");
assert.ok(adminOverview.data.apps.some(x => x.id === appId));
assert.ok(adminOverview.data.channels.length >= 2);
assert.ok(adminOverview.data.ads.some(x => x.title === adTitle));
passed("admin analytics read-back");

console.log("\nREAL INTEGRATION TESTS PASSED. Test records and objects remain in the disposable integration D1/R2 resources for inspection.");
console.log("Important: initData in this harness is HMAC-signed test data generated from the bot token, not initData captured from a live Telegram WebView.");
