import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import worker, { sha256Readable } from "../src/index.js";

const TOKEN = "123456:TEST_TOKEN_FOR_UNIT_TESTS_ONLY";
class MockDB {
  prepare(sql) {
    return {
      bind: (...args) => ({
        first: async () => {
          if (sql.includes("SELECT is_blocked")) return { is_blocked: 0 };
          if (sql.includes("SELECT count FROM rate_limits")) return { count: 1 };
          if (sql.includes("SELECT language FROM users")) return { language: "ru" };
          if (sql.includes("FROM apps WHERE id=? AND status='published'")) return { id: 1, apk_key: "apk/test.apk" };
          if (sql.includes("COUNT(*)")) return { n: 0 };
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1, last_row_id: 1 } })
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 1, last_row_id: 1 } })
    };
  }
}
const env = () => ({ DB: new MockDB(), FILES: { get: async () => null }, BOT_TOKEN: TOKEN, ADMIN_IDS: "42", ALLOWED_ORIGIN: "https://mini.example" });
function signedInitData(userId = 42, ageSeconds = 0) {
  const authDate = Math.floor(Date.now() / 1000) - ageSeconds;
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "AAE-test",
    user: JSON.stringify({ id: userId, first_name: "Test", username: "tester" })
  });
  const check = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}
async function call(path, { method = "GET", initData, body, headers = {}, environment = env() } = {}) {
  const h = new Headers(headers);
  if (initData) h.set("X-Telegram-Init-Data", initData);
  if (body !== undefined) { h.set("content-type", "application/json"); body = JSON.stringify(body); }
  return worker.fetch(new Request("https://api.example/api" + path, { method, headers: h, body }), environment);
}

test("health endpoint is available without Telegram session", async () => {
  const response = await call("/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "online");
});
test("user routes reject missing or forged Telegram initData", async () => {
  assert.equal((await call("/me")).status, 401);
  assert.equal((await call("/me", { initData: "user=%7B%7D&hash=bad" })).status, 401);
});
test("admin routes reject missing session and non-admin users", async () => {
  assert.equal((await call("/admin/overview")).status, 401);
  assert.equal((await call("/admin/overview", { initData: signedInitData(7) })).status, 403);
});
test("valid Telegram initData authenticates and loads profile", async () => {
  const response = await call("/me", { initData: signedInitData(42) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.user.id, "42");
  assert.equal(data.is_admin, true);
  assert.equal(data.language, "ru");
});
test("stale Telegram initData is rejected", async () => {
  assert.equal((await call("/me", { initData: signedInitData(42, 90000) })).status, 401);
});
test("public catalog uses parameterized D1 query", async () => {
  const response = await call("/apps");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).apps, []);
});
test("media route does not expose arbitrary R2 keys", async () => {
  const response = await call("/media/private.apk");
  assert.equal(response.status, 404);
});
test("preflight advertises Telegram auth header", async () => {
  const response = await call("/health", { method: "OPTIONS", headers: { Origin: "https://mini.example" } });
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers"), /X-Telegram-Init-Data/);
});

test("streaming SHA-256 matches known digest across arbitrary chunks", async () => {
  const chunks = [new TextEncoder().encode("a"), new TextEncoder().encode("b"), new TextEncoder().encode("c")];
  const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  assert.equal(await sha256Readable(stream), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
test("streaming SHA-256 handles multi-block payloads", async () => {
  const bytes = new TextEncoder().encode("APPNEST ".repeat(1000));
  const stream = new ReadableStream({ start(controller) { for(let i=0;i<bytes.length;i+=73) controller.enqueue(bytes.slice(i,i+73)); controller.close(); } });
  assert.equal(await sha256Readable(stream), createHash("sha256").update(bytes).digest("hex"));
});

test("download tickets are opaque, short-lived and one-time", async () => {
  const response = await call("/download/" + "a".repeat(64));
  assert.equal(response.status, 410);
});

test("authenticated user receives a short-lived download ticket, not an APK body", async () => {
  const response = await call("/apps/1/download-ticket", { method: "POST", initData: signedInitData(42), body: {} });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.url, /^\/api\/download\/[a-f0-9]{64}$/);
  assert.ok(data.expires_at > Math.floor(Date.now() / 1000));
  assert.ok(data.expires_at <= Math.floor(Date.now() / 1000) + 60);
});
test("user can persist one of the supported UI languages", async () => {
  const response = await call("/me", { method: "PATCH", initData: signedInitData(42), body: { language: "tj" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).language, "tj");
});

test("CORS rejects an origin other than the configured Mini App", async () => {
  const response = await call("/health", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});
test("public version history is restricted to published applications", async () => {
  const response = await call("/apps/1/versions", { initData: signedInitData(42) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).versions, []);
});
test("multipart upload creation rejects unauthenticated callers", async () => {
  const response = await call("/admin/uploads", { method: "POST", body: { kind: "apk", filename: "test.apk", size_bytes: 8, version: "1.0", version_code: 1 } });
  assert.equal(response.status, 401);
});
