import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import worker, { sha256Readable, cleanupExpired, mediaObject } from "../src/index.js";

const TOKEN = "123456:TEST_TOKEN_FOR_UNIT_TESTS_ONLY";
class MockDB {
  prepare(sql) {
    return {
      bind: (...args) => ({
        first: async () => {
          if (sql.includes("SELECT is_blocked")) return { is_blocked: 0 };
          if (sql.includes("SELECT count FROM appnest_rate_limits")) return { count: 1 };
          if (sql.includes("SELECT language FROM users")) return { language: "ru" };
          if (sql.includes("FROM appnest_apps WHERE id=? AND status='published'")) return { id: 1, apk_key: "apk/test.apk" };
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
const env = () => ({ DB: new MockDB(), FILES: { get: async () => null }, BOT_TOKEN: TOKEN, ADMIN_IDS: "42", ALLOWED_ORIGIN: "https://mini.example", TELEGRAM_SUBSCRIPTIONS_ENABLED: "true" });
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
async function call(path, { method = "GET", initData, body, rawBody, headers = {}, environment = env() } = {}) {
  const h = new Headers(headers);
  if (initData) h.set("X-Telegram-Init-Data", initData);
  if (rawBody !== undefined) { h.set("content-type", typeof rawBody === "string" ? "application/json" : "application/octet-stream"); body=rawBody; }
  else if (body !== undefined) { h.set("content-type", "application/json"); body = JSON.stringify(body); }
  return worker.fetch(new Request("https://api.example/api" + path, { method, headers: h, body }), environment);
}

test("health endpoint is available without Telegram session", async () => {
  const response = await call("/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "online");
});
test("guest access creates a server session without email or Telegram", async () => {
  const response = await call("/auth/guest", { method: "POST", body: {} });
  assert.equal(response.status, 201);
  assert.match(response.headers.get("set-cookie") || "", /appnest_session=.*HttpOnly/);
  const data = await response.json();
  assert.equal(data.success, true);
  assert.equal(data.guest, true);
  assert.equal(data.is_admin, false);
});
test("cross-origin state-changing requests are rejected", async () => {
  const denied=await call("/auth/guest",{method:"POST",body:{},headers:{Origin:"https://attacker.example"}});
  assert.equal(denied.status,403);
  const allowed=await call("/auth/guest",{method:"POST",body:{},headers:{Origin:"https://appnest-web.anas-grow-up-3.workers.dev"}});
  assert.equal(allowed.status,201);
});
test("canonical APPNEST web origin is allowed for credentialed sessions", async () => {
  const response = await call("/health", { method: "OPTIONS", headers: { Origin: "https://appnest-web.anas-grow-up-3.workers.dev" } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://appnest-web.anas-grow-up-3.workers.dev");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
});
test("standalone registration rejects weak passwords before creating an account", async () => {
  const response = await call("/auth/register", { method: "POST", body: { email: "user@example.com", name: "User", password: "short" } });
  assert.equal(response.status, 400);
});
test("standalone login rejects empty credentials", async () => {
  const response = await call("/auth/login", { method: "POST", body: { email: "", password: "" } });
  assert.equal(response.status, 400);
});
test("user routes reject missing or forged Telegram initData", async () => {
  assert.equal((await call("/me")).status, 401);
  assert.equal((await call("/me", { initData: "user=%7B%7D&hash=bad" })).status, 401);
});
test("new admin security routes reject unauthenticated and non-admin callers", async () => {
  for (const [method,path] of [["GET","/admin/diagnostics"],["POST","/admin/diagnostics/channel"],["GET","/admin/subscriptions-enabled"],["PUT","/admin/subscriptions-enabled"],["POST","/admin/recovery-codes"],["DELETE","/admin/recovery-codes"]]) {
    const options=method==="GET"?{method}:{method,body:{}};
    assert.equal((await call(path,options)).status,401);
    assert.equal((await call(path,{...options,initData:signedInitData(7)})).status,403);
  }
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
test("preflight advertises Telegram auth header only to configured origin", async () => {
  const response = await call("/health", { method: "OPTIONS", headers: { Origin: "https://mini.example" } });
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers"), /X-Telegram-Init-Data/);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://mini.example");
  const denied = await call("/health", { method: "OPTIONS", headers: { Origin: "https://attacker.example" } });
  assert.equal(denied.status, 204);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
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

test("R2 multipart rejects a part whose size is not the required 8 MiB", async () => {
  let partCalls=0;
  const customEnv={
    ...env(),
    DB:{
      prepare(sql){return{
        bind(...args){return{
          first:async()=>{
            if(sql.includes("SELECT is_blocked"))return{is_blocked:0};
            if(sql.includes("SELECT count FROM appnest_rate_limits"))return{count:1};
            if(sql.includes("SELECT * FROM appnest_upload_sessions"))return{id:"upload-1",owner_id:"42",object_key:"apk/test.apk",r2_upload_id:"r2-id",expected_size:8388609,expires_at:Math.floor(Date.now()/1000)+600};
            if(sql.includes("COALESCE(SUM(size_bytes)"))return{n:0};
            return null;
          },
          all:async()=>({results:[]}),
          run:async()=>({meta:{changes:1}})
        };},
        first:async()=>null,all:async()=>({results:[]}),run:async()=>({meta:{changes:1}})
      };},
    },
    FILES:{resumeMultipartUpload(){return{uploadPart:async()=>{partCalls++;return{etag:"etag"};}};}}
  };
  const response=await call("/admin/uploads/upload-1/parts?part_number=1",{
    method:"PUT",initData:signedInitData(42),body:new Uint8Array([1]),
    headers:{"Content-Length":"1"},environment:customEnv
  });
  assert.equal(response.status,413);
  assert.equal(partCalls,0);
});
test("admin campaign creation rejects invalid date strings", async () => {
  const response=await call("/admin/ads",{
    method:"POST",initData:signedInitData(42),
    body:{title:"Test",kind:"banner",target_url:"https://example.com",starts_at:"not-a-date",ends_at:"also-not-a-date"}
  });
  assert.equal(response.status,400);
});

test("malformed JSON receives a client error instead of an internal error", async () => {
  const response=await call("/feedback",{method:"POST",initData:signedInitData(42),rawBody:"{broken"});
  assert.equal(response.status,400);
});
test("JSON body size is enforced even when Content-Length is not trusted", async () => {
  const response=await call("/feedback",{method:"POST",initData:signedInitData(42),rawBody:JSON.stringify({message:"x".repeat(70000)})});
  assert.equal(response.status,413);
});

test("Telegram membership API outage fails closed even in any-channel mode", async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error("Telegram unavailable");};
  const customEnv={
    ...env(),
    DB:{
      prepare(sql){return{
        bind(...args){return{
          first:async()=>{
            if(sql.includes("SELECT is_blocked"))return{is_blocked:0};
            if(sql.includes("SELECT count FROM appnest_rate_limits"))return{count:1};
            if(sql.includes("FROM appnest_apps WHERE id=? AND status='published'"))return{id:1,apk_key:"apk/test.apk"};
            if(sql.includes("settings WHERE key='subscription_mode'"))return{value:"any"};
            return null;
          },
          all:async()=>({results:sql.includes("FROM appnest_required_channels")?[{chat_id:"@required",title:"Required",invite_url:"https://t.me/required"}]:[]}),
          run:async()=>({meta:{changes:1}})
        };},
        first:async()=>null,
        all:async()=>({results:sql.includes("FROM appnest_required_channels")?[{chat_id:"@required",title:"Required",invite_url:"https://t.me/required"}]:[]}),
        run:async()=>({meta:{changes:1}})
      };},
    }
  };
  try{
    const response=await call("/apps/1/download-ticket",{method:"POST",initData:signedInitData(42),body:{},environment:customEnv});
    assert.equal(response.status,403);
    const data=await response.json();
    assert.equal(data.subscription_required,true);
    assert.equal(data.mode,"unavailable");
  }finally{globalThis.fetch=originalFetch;}
});

test("scheduled cleanup aborts expired R2 multipart sessions and batches retention cleanup", async () => {
  let aborted=false,batchCount=0;
  const customEnv={
    DB:{
      prepare(sql){return{
        bind(){return{
          all:async()=>({results:sql.includes("FROM appnest_upload_sessions WHERE status='open'")?[{id:"expired-1",object_key:"apk/expired.apk",r2_upload_id:"r2-expired"}]:[]}),
          run:async()=>({meta:{changes:1}})
        };},
        all:async()=>({results:[]}),run:async()=>({meta:{changes:1}})
      };},
      batch:async statements=>{batchCount=statements.length;return[];}
    },
    FILES:{resumeMultipartUpload(){return{abort:async()=>{aborted=true;}};}}
  };
  await cleanupExpired(customEnv);
  assert.equal(aborted,true);
  assert.equal(batchCount,5);
});

test("published media lookup requires an exact referenced key and media namespace", async () => {
  const customEnv={
    DB:{prepare(sql){return{bind(...args){return{all:async()=>({results:[{icon_key:"icons/legacy.png",banner_key:"media/banner.png",screenshots_json:'["media/screen.png"]'}]})};}};}},
    FILES:{get:async key=>({key,body:new Uint8Array([1])})}
  };
  assert.equal((await mediaObject(customEnv,"icons/legacy.png")).key,"icons/legacy.png");
  assert.equal((await mediaObject(customEnv,"media/banner.png")).key,"media/banner.png");
  assert.equal((await mediaObject(customEnv,"media/screen.png")).key,"media/screen.png");
  assert.equal(await mediaObject(customEnv,"media/screen.png.evil"),null);
  assert.equal(await mediaObject(customEnv,"media/not-referenced.png"),null);
  assert.equal(await mediaObject(customEnv,"apk/private.apk"),null);
});
test("worker rejects an unconfigured CORS origin instead of emitting wildcard", async () => {
  const environment={...env(),ALLOWED_ORIGIN:""};
  const response=await call("/health",{headers:{Origin:"https://mini.example"},environment});
  assert.equal(response.headers.get("access-control-allow-origin"),null);
});



test("CORS supports an explicit allowlist of multiple Mini App origins", async () => {
  const environment={...env(),ALLOWED_ORIGIN:"",ALLOWED_ORIGINS:"https://mini.example, https://preview.example"};
  const allowed=await call("/health",{headers:{Origin:"https://preview.example"},environment});
  assert.equal(allowed.headers.get("access-control-allow-origin"),"https://preview.example");
  const denied=await call("/health",{headers:{Origin:"https://attacker.example"},environment});
  assert.equal(denied.headers.get("access-control-allow-origin"),null);
});

test("every registered admin route rejects unauthenticated and non-admin callers", async () => {
  const routes = [
    ["GET","/admin/categories"],["POST","/admin/categories"],["GET","/admin/subscriptions-enabled"],["PUT","/admin/subscriptions-enabled"],["PATCH","/admin/categories/1"],["DELETE","/admin/categories/1"],
    ["POST","/admin/uploads"],["PUT","/admin/uploads/upload-1/parts"],["POST","/admin/uploads/upload-1/complete"],["DELETE","/admin/uploads/upload-1"],
    ["GET","/admin/apps/1/versions"],["PATCH","/admin/channels/1"],["DELETE","/admin/channels/1"],
    ["PATCH","/admin/ads/1"],["DELETE","/admin/ads/1"],["GET","/admin/notifications"],["PATCH","/admin/notifications/1"],
    ["PATCH","/admin/feedback/1"],["GET","/admin/users"],["GET","/admin/overview"],["POST","/admin/apps"],
    ["PATCH","/admin/apps/1"],["POST","/admin/channels"],["PUT","/admin/subscription-mode"],["POST","/admin/ads"],
    ["PATCH","/admin/users/1"],["POST","/admin/notifications"],["GET","/admin/feedback"],["GET","/admin/audit"]
  ];
  for (const [method,path] of routes) {
    const unauthenticated = await call(path,{method});
    assert.equal(unauthenticated.status,401,method+" "+path+" must reject missing initData");
    const nonAdmin = await call(path,{method,initData:signedInitData(7)});
    assert.equal(nonAdmin.status,403,method+" "+path+" must reject non-admin users");
  }
});

test("Telegram initData rejects a modified user payload even when original hash is retained", async () => {
  const params = new URLSearchParams(signedInitData(42));
  params.set("user",JSON.stringify({id:7,first_name:"Attacker"}));
  const response = await call("/me",{initData:params.toString()});
  assert.equal(response.status,401);
});

test("multipart image upload streams a part, completes, and attaches media using R2 mock", async () => {
  const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  let session = null, partRows = [], uploaded = null, completed = false, attached = false;
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("SELECT is_blocked")) return {is_blocked:0};
              if (sql.includes("SELECT count FROM appnest_rate_limits")) return {count:1};
              if (sql.includes("SELECT * FROM appnest_upload_sessions")) return session;
              if (sql.includes("SELECT id FROM appnest_apps") || sql.includes("SELECT id,version_code FROM appnest_apps")) return {id:5,version_code:1};
              if (sql.includes("SELECT screenshots_json")) return {screenshots_json:"[]"};
              if (sql.includes("COALESCE(SUM(size_bytes)")) return {n:0};
              return null;
            },
            all: async () => {
              if (sql.includes("SELECT part_number,etag,size_bytes FROM appnest_upload_parts")) return {results:partRows};
              return {results:[]};
            },
            run: async () => {
              if (sql.includes("INSERT INTO appnest_upload_sessions")) {
                session={id:args[0],owner_id:args[1],app_id:args[2],object_key:args[3],r2_upload_id:args[4],metadata_json:args[5],expected_size:args[6],client_sha256:args[7],expires_at:args[8],status:"open"};
              }
              if (sql.includes("INSERT INTO appnest_upload_parts")) partRows=[{part_number:args[1],etag:args[2],size_bytes:args[3]}];
              if (sql.includes("UPDATE appnest_apps SET icon_key")) attached=true;
              if (sql.includes("UPDATE appnest_upload_sessions SET status='completed'")) session.status="completed";
              return {meta:{changes:1,last_row_id:5}};
            }
          };
        },
        first:async()=>null,all:async()=>({results:[]}),run:async()=>({meta:{changes:1,last_row_id:5}})
      };
    }
  };
  const files = {
    createMultipartUpload: async () => ({uploadId:"mock-r2-upload"}),
    resumeMultipartUpload: () => ({
      uploadPart: async (_number,body) => {
        const reader=body.getReader(),chunks=[];
        while(true){const item=await reader.read();if(item.done)break;chunks.push(...item.value);}
        uploaded=Uint8Array.from(chunks);
        return {etag:"mock-etag"};
      },
      complete: async () => {completed=true;},
      abort: async () => {}
    }),
    get: async (_key,options) => {
      const bytes=options?.range?png.slice(0,options.range.length):png;
      return {size:png.length,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
    },
    delete:async()=>{}
  };
  const environment={...env(),DB:db,FILES:files};
  const create=await call("/admin/uploads",{method:"POST",initData:signedInitData(42),environment,body:{
    kind:"icon",filename:"icon.png",size_bytes:png.length,content_type:"image/png",app_id:5
  }});
  assert.equal(create.status,201);
  const uploadId=(await create.json()).upload_id;
  const part=await call("/admin/uploads/"+uploadId+"/parts?part_number=1",{
    method:"PUT",initData:signedInitData(42),environment,rawBody:png,
    headers:{"Content-Length":String(png.length)}
  });
  assert.equal(part.status,200);
  assert.deepEqual(uploaded,png);
  const finish=await call("/admin/uploads/"+uploadId+"/complete",{
    method:"POST",initData:signedInitData(42),environment,body:{}
  });
  assert.equal(finish.status,200);
  assert.equal(completed,false,"completed R2 object is already present in this test fixture");
  assert.equal(attached,true);
  assert.equal(session.status,"completed");
});

test("multipart upload cannot be accessed by a different Telegram owner", async () => {
  const customEnv={
    ...env(),
    DB:{
      prepare(sql){return{bind(){return{
        first:async()=>sql.includes("SELECT is_blocked")?{is_blocked:0}:sql.includes("SELECT count FROM appnest_rate_limits")?{count:1}:sql.includes("SELECT * FROM appnest_upload_sessions")?null:null,
        all:async()=>({results:[]}),run:async()=>({meta:{changes:1}})
      };},first:async()=>null,all:async()=>({results:[]}),run:async()=>({meta:{changes:1}})};}
    }
  };
  const response=await call("/admin/uploads/another-users-upload/parts?part_number=1",{
    method:"PUT",initData:signedInitData(42),environment:customEnv,body:new Uint8Array([1]),
    headers:{"Content-Length":"1"}
  });
  assert.equal(response.status,404);
});


test("Telegram getChatMember mock enforces all and any subscription modes", async () => {
  const originalFetch=globalThis.fetch;
  const channels=[
    {chat_id:"@channel_one",title:"One",invite_url:"https://t.me/channel_one"},
    {chat_id:"@channel_two",title:"Two",invite_url:"https://t.me/channel_two"}
  ];
  const membership={"@channel_one":"member","@channel_two":"left"};
  async function status(mode) {
    const customEnv={
      ...env(),
      DB:{
        prepare(sql){return{
          bind(){return{
            first:async()=>sql.includes("SELECT is_blocked")?{is_blocked:0}:sql.includes("SELECT count FROM appnest_rate_limits")?{count:1}:sql.includes("SELECT value FROM appnest_settings")?{value:mode}:null,
            all:async()=>({results:sql.includes("FROM appnest_required_channels")?channels:[]}),
            run:async()=>({meta:{changes:1}})
          };},
          first:async()=>sql.includes("SELECT value FROM appnest_settings")?{value:mode}:null,
          all:async()=>({results:sql.includes("FROM appnest_required_channels")?channels:[]}),
          run:async()=>({meta:{changes:1}})
        };}
      }
    };
    globalThis.fetch=async(_url,options)=>{
      const body=JSON.parse(options.body);
      return new Response(JSON.stringify({ok:true,result:{status:membership[body.chat_id]}}),{status:200,headers:{"content-type":"application/json"}});
    };
    const response=await call("/subscription/status",{initData:signedInitData(42),environment:customEnv});
    assert.equal(response.status,200);
    return response.json();
  }
  try {
    const all=await status("all");
    assert.equal(all.allowed,false);
    assert.equal(all.channels.filter(x=>x.subscribed).length,1);
    const any=await status("any");
    assert.equal(any.allowed,true);
    assert.equal(any.channels.filter(x=>x.subscribed).length,1);
    membership["@channel_two"]="administrator";
    const allMembers=await status("all");
    assert.equal(allMembers.allowed,true);
  } finally {
    globalThis.fetch=originalFetch;
  }
});



test("Telegram 429 retry_after is respected once when the wait is short", async () => {
  const originalFetch=globalThis.fetch;
  let calls=0;
  const channel={chat_id:"@retry_channel",title:"Retry",invite_url:"https://t.me/retry_channel"};
  const customEnv={
    ...env(),
    DB:{
      prepare(sql){return{
        bind(){return{
          first:async()=>sql.includes("SELECT is_blocked")?{is_blocked:0}:sql.includes("SELECT count FROM appnest_rate_limits")?{count:1}:sql.includes("SELECT value FROM appnest_settings")?{value:"all"}:null,
          all:async()=>({results:sql.includes("FROM appnest_required_channels")?[channel]:[]}),
          run:async()=>({meta:{changes:1}})
        };},
        first:async()=>sql.includes("SELECT value FROM appnest_settings")?{value:"all"}:null,
        all:async()=>({results:sql.includes("FROM appnest_required_channels")?[channel]:[]}),
        run:async()=>({meta:{changes:1}})
      };}
    }
  };
  globalThis.fetch=async()=>{
    calls++;
    if(calls===1)return new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:1}}),{status:429,headers:{"content-type":"application/json"}});
    return new Response(JSON.stringify({ok:true,result:{status:"member"}}),{status:200,headers:{"content-type":"application/json"}});
  };
  try{
    const response=await call("/subscription/status",{initData:signedInitData(42),environment:customEnv});
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(calls,2);
    assert.equal(data.allowed,true);
    assert.equal(data.unavailable,false);
  }finally{globalThis.fetch=originalFetch;}
});

test("Telegram 429 with a longer retry_after fails closed without a premature retry", async () => {
  const originalFetch=globalThis.fetch;
  let calls=0;
  const channel={chat_id:"@slow_channel",title:"Slow",invite_url:"https://t.me/slow_channel"};
  const customEnv={
    ...env(),
    DB:{
      prepare(sql){return{
        bind(){return{
          first:async()=>sql.includes("SELECT is_blocked")?{is_blocked:0}:sql.includes("SELECT count FROM appnest_rate_limits")?{count:1}:sql.includes("SELECT value FROM appnest_settings")?{value:"all"}:null,
          all:async()=>({results:sql.includes("FROM appnest_required_channels")?[channel]:[]}),
          run:async()=>({meta:{changes:1}})
        };},
        first:async()=>sql.includes("SELECT value FROM appnest_settings")?{value:"all"}:null,
        all:async()=>({results:sql.includes("FROM appnest_required_channels")?[channel]:[]}),
        run:async()=>({meta:{changes:1}})
      };}
    }
  };
  globalThis.fetch=async()=>{
    calls++;
    return new Response(JSON.stringify({ok:false,error_code:429,parameters:{retry_after:5}}),{status:429,headers:{"content-type":"application/json"}});
  };
  try{
    const response=await call("/subscription/status",{initData:signedInitData(42),environment:customEnv});
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(calls,1);
    assert.equal(data.allowed,false);
    assert.equal(data.unavailable,true);
    assert.equal(data.channels[0].retry_after,5);
  }finally{globalThis.fetch=originalFetch;}
});

test("Telegram 5xx response is retried once before failing or accepting membership", async () => {
  const originalFetch=globalThis.fetch;
  let calls=0;
  const channel={chat_id:"@server_channel",title:"Server",invite_url:"https://t.me/server_channel"};
  const customEnv={
    ...env(),
    DB:{
      prepare(sql){return{
        bind(){return{
          first:async()=>sql.includes("SELECT is_blocked")?{is_blocked:0}:sql.includes("SELECT count FROM appnest_rate_limits")?{count:1}:sql.includes("SELECT value FROM appnest_settings")?{value:"all"}:null,
          all:async()=>({results:sql.includes("FROM appnest_required_channels")?[channel]:[]}),
          run:async()=>({meta:{changes:1}})
        };},
        first:async()=>sql.includes("SELECT value FROM appnest_settings")?{value:"all"}:null,
        all:async()=>({results:sql.includes("FROM appnest_required_channels")?[channel]:[]}),
        run:async()=>({meta:{changes:1}})
      };}
    }
  };
  globalThis.fetch=async()=>{
    calls++;
    if(calls===1)return new Response("temporary error",{status:503});
    return new Response(JSON.stringify({ok:true,result:{status:"administrator"}}),{status:200,headers:{"content-type":"application/json"}});
  };
  try{
    const response=await call("/subscription/status",{initData:signedInitData(42),environment:customEnv});
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(calls,2);
    assert.equal(data.allowed,true);
  }finally{globalThis.fetch=originalFetch;}
});

test("POST /auth/admin-telegram without initData is a 401 auth error, never 404", async () => {
  const response = await call("/auth/admin-telegram", { method: "POST", body: {} });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).success, false);
});
test("POST /auth/admin-telegram creates a session for the configured admin and reports is_admin", async () => {
  const response = await call("/auth/admin-telegram", { method: "POST", body: {}, initData: signedInitData(42) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") || "", /appnest_session=[a-f0-9]{64}; Path=\/api; .*HttpOnly; Secure/);
  assert.equal((await response.json()).is_admin, true);
});
test("POST /auth/admin-telegram refuses a valid Telegram user who is not an admin", async () => {
  const response = await call("/auth/admin-telegram", { method: "POST", body: {}, initData: signedInitData(7) });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);
});
test("ADMIN_IDS tolerates spaces and the numeric Telegram id is compared as a string", async () => {
  const environment = { ...env(), ADMIN_IDS: " 7 , 8335750192 " };
  const response = await call("/me", { initData: signedInitData(8335750192), environment });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).is_admin, true);
  const other = await call("/me", { initData: signedInitData(83357501), environment });
  assert.equal((await other.json()).is_admin, false);
});
test("API path is tolerated with or without a duplicated /api prefix", async () => {
  for (const prefix of ["/api", "/api/api", ""]) {
    const response = await worker.fetch(new Request("https://api.example" + prefix + "/auth/admin-telegram", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), env());
    assert.equal(response.status, 401, prefix);
  }
  const health = await worker.fetch(new Request("https://api.example/api/api/health"), env());
  assert.equal(health.status, 200);
});
test("verified admin initData takes precedence over an existing non-admin cookie session", async () => {
  const base = env();
  const guestDb = {
    prepare(sql) {
      const inner = base.DB.prepare(sql);
      return { ...inner, bind: (...args) => ({ ...inner.bind(...args),
        first: async () => {
          if (sql.includes("FROM appnest_auth_sessions")) return { user_id: "guest_1", expires_at: Math.floor(Date.now()/1000) + 1000 };
          if (sql.includes("FROM users u LEFT JOIN appnest_credentials")) return { telegram_id: args[0], username: "", first_name: "Гость", last_name: "", photo_url: "", email: "" };
          return inner.bind(...args).first();
        } }) };
    }
  };
  const environment = { ...base, DB: guestDb };
  const cookie = { cookie: "appnest_session=" + "a".repeat(64) };
  const guest = await call("/me", { headers: cookie, environment });
  assert.equal((await guest.json()).is_admin, false);
  const admin = await call("/me", { headers: cookie, initData: signedInitData(42), environment });
  assert.equal((await admin.json()).is_admin, true);
  const impostor = await call("/me", { headers: cookie, initData: signedInitData(7), environment });
  assert.equal((await impostor.json()).is_admin, false);
});
