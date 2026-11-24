const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_JSON = 64 * 1024;
const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function fail(message, status = 400) { return json({ success: false, error: message }, status); }
function clean(value, max = 5000) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function hex(buffer) { return [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function hmac(key, data) {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data));
}
async function verifyTelegram(initData, token, maxAge = 86400) {
  if (!initData || !token || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isInteger(authDate)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > maxAge) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(encoder.encode("WebAppData"), encoder.encode(token));
  const expected = hex(await hmac(secret, encoder.encode(check)));
  if (!constantTimeEqual(expected, hash.toLowerCase())) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    if (!user || !Number.isSafeInteger(Number(user.id))) return null;
    return { id: String(user.id), username: clean(user.username, 64), first_name: clean(user.first_name, 128), last_name: clean(user.last_name, 128), photo_url: clean(user.photo_url, 1024) };
  } catch { return null; }
}

function cookieValue(request,name) {
  const raw=request.headers.get("Cookie")||"";
  for(const part of raw.split(";")){const i=part.indexOf("=");if(i<0)continue;if(part.slice(0,i).trim()===name)return decodeURIComponent(part.slice(i+1).trim());}
  return "";
}
function sessionCookie(token,maxAge=2592000){return `appnest_session=${encodeURIComponent(token)}; Path=/api; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;}
async function passwordHash(password,saltHex) {
  const salt=saltHex?Uint8Array.from(saltHex.match(/../g).map(x=>parseInt(x,16))):crypto.getRandomValues(new Uint8Array(16));
  const key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations:210000},key,256);
  return {salt:hex(salt),hash:hex(bits)};
}
async function issueWebSession(env,userId) {
  const token=hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash=hex(await crypto.subtle.digest("SHA-256",encoder.encode(token)));
  const expires=Math.floor(Date.now()/1000)+2592000;
  await env.DB.prepare("INSERT INTO appnest_auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").bind(tokenHash,userId,expires).run();
  return token;
}
async function webUserById(env,userId) {
  const row=await env.DB.prepare("SELECT u.telegram_id,u.username,u.first_name,u.last_name,u.photo_url,u.is_blocked,c.email FROM users u LEFT JOIN appnest_credentials c ON c.user_id=u.telegram_id WHERE u.telegram_id=?").bind(userId).first();
  if(!row)return null;
  return {id:String(row.telegram_id),username:row.username||"",first_name:row.first_name||"",last_name:row.last_name||"",photo_url:row.photo_url||"",email:row.email||""};
}
async function webAdmin(env,userId) {
  const ids=(env.ADMIN_IDS||"").split(",").map(x=>x.trim()).filter(Boolean);
  if(ids.includes(String(userId)))return true;
  const row=await env.DB.prepare("SELECT user_id FROM appnest_admins WHERE user_id=?").bind(String(userId)).first();
  return !!row;
}
async function createGuestAccount(env) {
  const userId="guest_"+crypto.randomUUID();
  const name="Гость";
  await env.DB.prepare("INSERT INTO users(telegram_id,username,first_name) VALUES(?,?,?)").bind(userId,"",name).run();
  const token=await issueWebSession(env,userId);
  return {user:await webUserById(env,userId),token};
}
async function authEndpoint(request,env,path,method) {
  if(path==="/auth/guest"&&method==="POST"){
    const ip=request.headers.get("CF-Connecting-IP")||"unknown";
    if(await rateLimit(env,"guest:"+ip,10,3600))return fail("Слишком много гостевых сессий с этого подключения. Попробуйте позже.",429);
    const account=await createGuestAccount(env);
    return json({success:true,user:account.user,is_admin:false,guest:true},201,{"set-cookie":sessionCookie(account.token)});
  }
  if(path==="/auth/register"&&method==="POST"){
    const b=await readJson(request),email=clean(b.email,254).toLowerCase(),password=typeof b.password==="string"?b.password:"",name=clean(b.name,80);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return fail("Укажите корректную почту");
    if(password.length<10||password.length>128)return fail("Пароль должен содержать от 10 до 128 символов");
    if(name.length<2)return fail("Укажите имя (минимум 2 символа)");
    if(await rateLimit(env,"register:"+hex(await crypto.subtle.digest("SHA-256",encoder.encode(email))),5,3600))return fail("Слишком много попыток. Попробуйте позже.",429);
    let userId="web_"+crypto.randomUUID();
    const tg=await verifyTelegram(request.headers.get("X-Telegram-Init-Data")||"",env.BOT_TOKEN,Number(env.TELEGRAM_AUTH_MAX_AGE||86400));
    if(tg){
      userId=tg.id;
      await env.DB.prepare("INSERT INTO users(telegram_id,username,first_name,last_name,photo_url) VALUES(?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,photo_url=CASE WHEN excluded.photo_url<>'' THEN excluded.photo_url ELSE users.photo_url END").bind(userId,tg.username,name,tg.last_name,tg.photo_url).run();
    }else{
      await env.DB.prepare("INSERT INTO users(telegram_id,username,first_name) VALUES(?,?,?)").bind(userId,email.split("@")[0].slice(0,64),name).run();
    }
    const existing=await env.DB.prepare("SELECT user_id FROM appnest_credentials WHERE email=? OR user_id=?").bind(email,userId).first();
    if(existing){if(userId.startsWith("web_"))await env.DB.prepare("DELETE FROM users WHERE telegram_id=?").bind(userId).run();return fail("Эта почта уже зарегистрирована или профиль уже привязан",409);}
    const derived=await passwordHash(password);
    await env.DB.prepare("INSERT INTO appnest_credentials(user_id,email,password_salt,password_hash) VALUES(?,?,?,?)").bind(userId,email,derived.salt,derived.hash).run();
    const token=await issueWebSession(env,userId),user=await webUserById(env,userId);
    return json({success:true,user,is_admin:await webAdmin(env,userId)},201,{"set-cookie":sessionCookie(token)});
  }
  if(path==="/auth/login"&&method==="POST"){
    const b=await readJson(request),email=clean(b.email,254).toLowerCase(),password=typeof b.password==="string"?b.password:"";
    if(!email||password.length>128)return fail("Проверьте почту и пароль");
    if(await rateLimit(env,"login:"+hex(await crypto.subtle.digest("SHA-256",encoder.encode(email))),10,900))return fail("Слишком много попыток. Подождите 15 минут.",429);
    const row=await env.DB.prepare("SELECT c.user_id,c.password_salt,c.password_hash,u.is_blocked FROM appnest_credentials c JOIN users u ON u.telegram_id=c.user_id WHERE c.email=?").bind(email).first();
    if(!row){await passwordHash(password,"00000000000000000000000000000000");return fail("Неверная почта или пароль",401);}
    const candidate=await passwordHash(password,row.password_salt);
    if(!constantTimeEqual(candidate.hash,row.password_hash))return fail("Неверная почта или пароль",401);
    if(row.is_blocked)return fail("Доступ к сервису ограничен",403);
    const token=await issueWebSession(env,row.user_id),user=await webUserById(env,row.user_id);
    return json({success:true,user,is_admin:await webAdmin(env,row.user_id)},200,{"set-cookie":sessionCookie(token)});
  }
  if(path==="/auth/admin-recovery"&&method==="POST"){
    const ip=request.headers.get("CF-Connecting-IP")||"unknown";
    if(await rateLimit(env,"admin-recovery:"+ip,5,900))return fail("Слишком много попыток. Подождите 15 минут.",429);
    const b=await readJson(request),code=clean(b.code,80).toUpperCase().replace(/[^A-F0-9]/g,"");
    if(!/^[A-F0-9]{32}$/.test(code))return fail("Неверный или использованный резервный код",401);
    const codeHash=hex(await crypto.subtle.digest("SHA-256",encoder.encode(code)));
    const row=await env.DB.prepare("SELECT id,user_id FROM appnest_admin_recovery_codes WHERE code_hash=? AND used_at IS NULL").bind(codeHash).first();
    if(!row||!(await webAdmin(env,row.user_id)))return fail("Неверный или использованный резервный код",401);
    const used=await env.DB.prepare("UPDATE appnest_admin_recovery_codes SET used_at=datetime('now') WHERE id=? AND used_at IS NULL").bind(row.id).run();
    if(!used.meta?.changes)return fail("Неверный или использованный резервный код",401);
    const blocked=await env.DB.prepare("SELECT is_blocked FROM users WHERE telegram_id=?").bind(row.user_id).first();
    if(blocked?.is_blocked)return fail("Доступ к сервису ограничен",403);
    const token=await issueWebSession(env,row.user_id),user=await webUserById(env,row.user_id);
    await audit(env,row.user_id,"admin.recovery_login","single-use-code");
    return json({success:true,user,is_admin:true},200,{"set-cookie":sessionCookie(token)});
  }
  if(path==="/auth/logout"&&method==="POST"){
    const token=cookieValue(request,"appnest_session");
    if(token){const hash=hex(await crypto.subtle.digest("SHA-256",encoder.encode(token)));await env.DB.prepare("DELETE FROM appnest_auth_sessions WHERE token_hash=?").bind(hash).run();}
    return json({success:true},200,{"set-cookie":sessionCookie("",0)});
  }
  return null;
}

async function readJson(request) {
  const body=await request.text();
  if(encoder.encode(body).byteLength>MAX_JSON) throw Object.assign(new Error("Слишком большой запрос"),{status:413});
  let value;
  try{value=JSON.parse(body);}catch{throw Object.assign(new Error("Некорректный JSON"),{status:400});}
  if(!value||typeof value!=="object"||Array.isArray(value)) throw Object.assign(new Error("Ожидается JSON-объект"),{status:400});
  return value;
}
async function rateLimit(env, key, limit = 60, windowSeconds = 60) {
  if (!env.DB) return false;
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const id = `${key}:${bucket}`;
  await env.DB.prepare("INSERT INTO appnest_rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count=count+1").bind(id, (bucket + 2) * windowSeconds).run();
  const row = await env.DB.prepare("SELECT count FROM appnest_rate_limits WHERE key=?").bind(id).first();
  if (bucket % 10 === 0) await env.DB.prepare("DELETE FROM appnest_rate_limits WHERE expires_at < ?").bind(Math.floor(Date.now()/1000)).run();
  return (row?.count || 0) > limit;
}
async function auth(request, env) {
  const cookie=cookieValue(request,"appnest_session");
  if(cookie){
    const tokenHash=hex(await crypto.subtle.digest("SHA-256",encoder.encode(cookie)));
    const row=await env.DB.prepare("SELECT user_id,expires_at FROM appnest_auth_sessions WHERE token_hash=?").bind(tokenHash).first();
    if(row&&row.expires_at>Math.floor(Date.now()/1000)){
      const user=await webUserById(env,row.user_id);
      if(!user)return {error:fail("Сессия недействительна. Войдите снова.",401)};
      const blocked=await env.DB.prepare("SELECT is_blocked FROM users WHERE telegram_id=?").bind(row.user_id).first();
      if(blocked?.is_blocked)return {error:fail("Доступ к сервису ограничен",403)};
      if(await rateLimit(env,"user:"+row.user_id,120))return {error:fail("Слишком много запросов",429)};
      return {user,isAdmin:await webAdmin(env,row.user_id)};
    }
    if(row)await env.DB.prepare("DELETE FROM appnest_auth_sessions WHERE token_hash=?").bind(tokenHash).run();
  }
  const raw=request.headers.get("X-Telegram-Init-Data")||"";
  const user=await verifyTelegram(raw,env.BOT_TOKEN,Number(env.TELEGRAM_AUTH_MAX_AGE||86400));
  if(!user)return {error:fail("Войдите в APPNEST по почте и паролю",401)};
  const uploadPartRequest=new URL(request.url).pathname.startsWith("/api/admin/uploads/")&&new URL(request.url).pathname.endsWith("/parts");
  if(await rateLimit(env,"user:"+user.id,uploadPartRequest?600:120))return {error:fail("Слишком много запросов",429)};
  const blocked=await env.DB.prepare("SELECT is_blocked FROM users WHERE telegram_id=?").bind(user.id).first();
  if(blocked?.is_blocked)return {error:fail("Доступ к сервису ограничен",403)};
  await env.DB.prepare("INSERT INTO users(telegram_id,username,first_name,last_name,photo_url) VALUES(?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,photo_url=CASE WHEN excluded.photo_url<>'' THEN excluded.photo_url ELSE users.photo_url END").bind(user.id,user.username,user.first_name,user.last_name,user.photo_url).run();
  return {user,isAdmin:await webAdmin(env,user.id)};
}
async function adminAuth(request, env) {
  const session = await auth(request, env);
  if (session.error) return session;
  if (!session.isAdmin) return { error: fail("Недостаточно прав", 403) };
  return session;
}
async function audit(env, actor, action, target, details = "") {
  await env.DB.prepare("INSERT INTO appnest_admin_audit (actor_id, action, target, details) VALUES (?, ?, ?, ?)").bind(actor, action, target, clean(details, 1000)).run();
}
async function subscriptionCheck(env, userId) {
  const { results = [] } = await env.DB.prepare("SELECT chat_id, title, invite_url FROM appnest_required_channels WHERE enabled=1").all();
  const enabledSetting=await env.DB.prepare("SELECT value FROM appnest_settings WHERE key='subscriptions_enabled'").first();
  const subscriptionsEnabled=enabledSetting && ["true","false"].includes(enabledSetting.value) ? enabledSetting.value==="true" : env.TELEGRAM_SUBSCRIPTIONS_ENABLED==="true";
  if (!results.length || !subscriptionsEnabled) return { allowed: true, channels: [] };
  if (!/^\d+$/.test(String(userId)) || !Number.isSafeInteger(Number(userId))) {
    return { allowed: false, unavailable: false, telegram_required: true, channels: results };
  }
  if (!env.BOT_TOKEN) return { allowed: false, unavailable: true, channels: results };
  const checks = await Promise.all(results.map(async channel => {
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: channel.chat_id, user_id: Number(userId) })
      });
      if (!response.ok) throw new Error("Telegram unavailable");
      const payload = await response.json();
      if (!payload.ok) throw new Error("Telegram unavailable");
      const status = payload.result?.status;
      return { ...channel, subscribed: ["creator","administrator","member"].includes(status) || (status === "restricted" && payload.result?.is_member === true) };
    } catch { return { ...channel, subscribed: false, unavailable: true }; }
  }));
  const mode = await env.DB.prepare("SELECT value FROM appnest_settings WHERE key='subscription_mode'").first();
  const any = mode?.value === "any";
  const unavailable = checks.some(x => x.unavailable);
  const allowed = !unavailable && (any ? checks.some(x => x.subscribed) : checks.every(x => x.subscribed));
  return { allowed, unavailable, channels: checks };
}
async function logDownload(env, userId, appId) {
  await env.DB.prepare("INSERT INTO appnest_downloads (user_id, app_id) VALUES (?, ?)").bind(userId, appId).run();
  await env.DB.prepare("UPDATE appnest_apps SET downloads=downloads+1 WHERE id=?").bind(appId).run();
}


const SHA256_K = new Uint32Array([
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
async function sha256Readable(stream) {
  const H=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const reader=stream.getReader();let carry=new Uint8Array(0),length=0;
  const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
  function compress(block){
    const w=new Uint32Array(64);
    for(let i=0;i<16;i++){const j=i*4;w[i]=((block[j]<<24)|(block[j+1]<<16)|(block[j+2]<<8)|block[j+3])>>>0;}
    for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2],s0=rotr(a,7)^rotr(a,18)^(a>>>3),s1=rotr(b,17)^rotr(b,19)^(b>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
    let [a,b,c,d,e,f,g,h]=H;
    for(let i=0;i<64;i++){const S1=rotr(e,6)^rotr(e,11)^rotr(e,25),ch=(e&f)^(~e&g),t1=(h+S1+ch+SHA256_K[i]+w[i])>>>0,S0=rotr(a,2)^rotr(a,13)^rotr(a,22),maj=(a&b)^(a&c)^(b&c),t2=(S0+maj)>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
  }
  while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;const merged=new Uint8Array(carry.length+value.length);merged.set(carry);merged.set(value,carry.length);let offset=0;while(offset+64<=merged.length){compress(merged.subarray(offset,offset+64));offset+=64;}carry=merged.slice(offset);}
  const padLength=carry.length<56?64:128,padded=new Uint8Array(padLength);padded.set(carry);padded[carry.length]=0x80;
  const bits=BigInt(length)*8n;for(let i=0;i<8;i++)padded[padLength-1-i]=Number((bits>>BigInt(i*8))&255n);
  for(let i=0;i<padLength;i+=64)compress(padded.subarray(i,i+64));
  return [...H].map(v=>v.toString(16).padStart(8,"0")).join("");
}

function safeJson(value, fallback = {}) { try { return JSON.parse(value || ""); } catch { return fallback; } }
function validHttpUrl(value) { try { const u=new URL(value); return u.protocol==="https:" && !u.username && !u.password; } catch { return false; } }
async function adminSession(request, env) { const a=await adminAuth(request,env); return a.error ? null : a; }
async function createMultipart(env,key,type) {
  return await env.FILES.createMultipartUpload(key,{httpMetadata:{contentType:type}});
}
async function uploadOwner(env,id,userId) {
  return await env.DB.prepare("SELECT * FROM appnest_upload_sessions WHERE id=? AND owner_id=? AND status='open' AND expires_at>?").bind(id,userId,Math.floor(Date.now()/1000)).first();
}
async function mediaObject(env,key) {
  if(typeof key!=="string"||(!key.startsWith("media/")&&!key.startsWith("icons/"))||key.length>200) return null;
  const {results=[]}=await env.DB.prepare("SELECT icon_key,banner_key,screenshots_json FROM appnest_apps WHERE status='published' AND (icon_key=? OR banner_key=? OR instr(screenshots_json,?)>0)").bind(key,key,key).all();
  const referenced=results.some(app=>app.icon_key===key||app.banner_key===key||safeArray(app.screenshots_json).includes(key));
  if(!referenced) return null;
  return await env.FILES.get(key);
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS", "access-control-allow-headers": "Content-Type,X-Telegram-Init-Data,Authorization", "access-control-allow-credentials": "true", "access-control-max-age": "86400" } });
  if (!env.DB) return fail("D1 binding DB не настроен", 503);
  if (path === "/health" && method === "GET") return json({ success: true, service: "APPNEST API", status: "online", storage: !!env.FILES });
  const authResponse=await authEndpoint(request,env,path,method);
  if(authResponse)return authResponse;
  if (path === "/categories" && method === "GET") { const {results=[]}=await env.DB.prepare("SELECT slug,title,icon FROM appnest_categories ORDER BY sort_order,title").all(); return json({success:true,categories:results}); }
  if (path === "/apps" && method === "GET") {
    const category = clean(url.searchParams.get("category"), 80);
    const query = clean(url.searchParams.get("q"), 100);
    let sql = "SELECT id,title,description,developer,category,version,version_code,min_android,size_bytes,icon_key,banner_key,screenshots_json,downloads,created_at,updated_at FROM appnest_apps WHERE status='published'";
    const args = [];
    if (category) { sql += " AND category=?"; args.push(category); }
    if (query) { sql += " AND (title LIKE ? OR description LIKE ? OR developer LIKE ?)"; args.push("%"+query+"%","%"+query+"%","%"+query+"%"); }
    sql += " ORDER BY created_at DESC LIMIT 100";
    const { results = [] } = await env.DB.prepare(sql).bind(...args).all();
    return json({ success: true, apps: results.map(a => ({ ...a, size: a.size_bytes ? (a.size_bytes / 1048576).toFixed(1) + " MB" : null, icon_url: a.icon_key ? "/api/media/" + encodeURIComponent(a.icon_key) : null, banner_url: a.banner_key ? "/api/media/" + encodeURIComponent(a.banner_key) : null, screenshots: safeArray(a.screenshots_json).map(key=>"/api/media/"+encodeURIComponent(key)) })) });
  }
  if (path.startsWith("/download/") && method === "GET") {
    const token=path.split("/")[2];
    if(!/^[a-f0-9]{64}$/.test(token)||!env.FILES) return fail("Ссылка на скачивание недействительна",404);
    const tokenHash=hex(await crypto.subtle.digest("SHA-256",encoder.encode(token)));
    const ticket=await env.DB.prepare("SELECT user_id,app_id FROM appnest_download_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?").bind(tokenHash,Math.floor(Date.now()/1000)).first();
    if(!ticket) return fail("Ссылка истекла или уже использована",410);
    const consumed=await env.DB.prepare("UPDATE appnest_download_tokens SET used_at=datetime('now') WHERE token_hash=? AND used_at IS NULL AND expires_at>?").bind(tokenHash,Math.floor(Date.now()/1000)).run();
    if(!consumed.meta?.changes) return fail("Ссылка уже использована",410);
    const app=await env.DB.prepare("SELECT id,apk_key FROM appnest_apps WHERE id=? AND status='published'").bind(ticket.app_id).first();
    if(!app) return fail("Приложение не найдено",404);
    const object=await env.FILES.get(app.apk_key);
    if(!object) return fail("APK-файл временно недоступен",404);
    await logDownload(env,ticket.user_id,ticket.app_id);
    return new Response(object.body,{headers:{"content-type":"application/vnd.android.package-archive","content-disposition":`attachment; filename="app-${app.id}.apk"`,"content-length":String(object.size),"x-content-type-options":"nosniff","cache-control":"private, no-store","etag":object.httpEtag||""}});
  }
  if (path.startsWith("/media/") && method === "GET") {
    if (!env.FILES) return fail("R2 binding FILES не настроен", 503);
    const key = decodeURIComponent(path.slice(7));
    const object = await mediaObject(env,key);
    if (!object) return fail("Файл не найден", 404);
    return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType || "application/octet-stream", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
  }
  const session = await auth(request, env);
  if (session.error) return session.error;
  const userId = session.user.id;
  if (path === "/me" && method === "GET") {
    const [favs, history, notes, language] = await Promise.all([
      env.DB.prepare("SELECT app_id FROM appnest_favorites WHERE user_id=?").bind(userId).all(),
      env.DB.prepare("SELECT d.app_id,a.title,d.created_at FROM appnest_downloads d JOIN appnest_apps a ON a.id=d.app_id WHERE d.user_id=? ORDER BY d.created_at DESC LIMIT 100").bind(userId).all(),
      env.DB.prepare("SELECT id,title,message,created_at FROM appnest_notifications WHERE active=1 ORDER BY created_at DESC LIMIT 30").all(),
      env.DB.prepare("SELECT language FROM users WHERE telegram_id=?").bind(userId).first()
    ]);
    return json({ success:true, user:session.user, language:language?.language || "ru", is_admin:session.isAdmin, favorites:(favs.results||[]).map(x=>String(x.app_id)), history:history.results||[], notifications:notes.results||[] });
  }
  if (path === "/me" && method === "PATCH") {
    const b=await readJson(request); if(!["ru","tj","en"].includes(b.language)) return fail("Unsupported language");
    await env.DB.prepare("UPDATE users SET language=? WHERE telegram_id=?").bind(b.language,userId).run();
    return json({success:true,language:b.language});
  }
  if (path.startsWith("/favorites/")) {
    const appId = Number(path.split("/")[2]);
    if (!Number.isSafeInteger(appId) || appId < 1) return fail("Некорректное приложение");
    if (method === "POST") {
      await env.DB.prepare("INSERT OR IGNORE INTO appnest_favorites(user_id,app_id) SELECT ?,id FROM appnest_apps WHERE id=? AND status='published'").bind(userId,appId).run();
      return json({ success:true });
    }
    if (method === "DELETE") { await env.DB.prepare("DELETE FROM appnest_favorites WHERE user_id=? AND app_id=?").bind(userId,appId).run(); return json({success:true}); }
  }
  if (path.startsWith("/apps/") && path.endsWith("/versions") && method === "GET") {
    const id=Number(path.split("/")[2]);
    if(!Number.isSafeInteger(id)||id<1) return fail("Некорректное приложение");
    const {results=[]}=await env.DB.prepare("SELECT v.version,v.version_code,v.min_android,v.size_bytes,v.release_notes,v.created_at FROM appnest_app_versions v JOIN appnest_apps a ON a.id=v.app_id WHERE v.app_id=? AND a.status='published' ORDER BY v.version_code DESC LIMIT 30").bind(id).all();
    return json({success:true,versions:results});
  }
  if (path.startsWith("/apps/") && path.endsWith("/download-ticket") && method === "POST") {
    const appId=Number(path.split("/")[2]);
    const app=await env.DB.prepare("SELECT id,apk_key FROM appnest_apps WHERE id=? AND status='published' AND apk_key IS NOT NULL").bind(appId).first();
    if(!app) return fail("Приложение не найдено",404);
    const subs=await subscriptionCheck(env,userId);
    if(!subs.allowed) return json({success:false,error:subs.telegram_required?"Для проверки подписки войдите в APPNEST через Telegram.":(subs.unavailable?"Не удалось проверить подписки. Повторите попытку позже.":"Для скачивания необходимо подписаться на каналы"),subscription_required:true,telegram_required:subs.telegram_required===true,mode:subs.telegram_required?"telegram_required":(subs.unavailable?"unavailable":"required"),channels:subs.channels.map(c=>({title:c.title,invite_url:c.invite_url,subscribed:c.subscribed}))},403);
    const bytes=crypto.getRandomValues(new Uint8Array(32)),token=hex(bytes),hash=hex(await crypto.subtle.digest("SHA-256",encoder.encode(token))),expiry=Math.floor(Date.now()/1000)+60;
    await env.DB.prepare("INSERT INTO appnest_download_tokens(token_hash,user_id,app_id,expires_at) VALUES(?,?,?,?)").bind(hash,userId,appId,expiry).run();
    return json({success:true,url:"/api/download/"+token,expires_at:expiry});
  }
  if (path.startsWith("/apps/") && path.endsWith("/download") && method === "POST") {
    const appId = Number(path.split("/")[2]);
    const app = await env.DB.prepare("SELECT id,apk_key,apk_sha256,title FROM appnest_apps WHERE id=? AND status='published'").bind(appId).first();
    if (!app || !app.apk_key) return fail("Приложение не найдено",404);
    const subs = await subscriptionCheck(env,userId);
    if (!subs.allowed) return json({ success:false, error:subs.telegram_required ? "Для проверки подписки войдите в APPNEST через Telegram." : (subs.unavailable ? "Не удалось проверить подписки. Повторите попытку позже." : "Для скачивания необходимо подписаться на каналы"), subscription_required:true, telegram_required:subs.telegram_required===true, mode:subs.telegram_required ? "telegram_required" : (subs.unavailable ? "unavailable" : "required"), channels:subs.channels.map(c=>({title:c.title,invite_url:c.invite_url,subscribed:c.subscribed})) },403);
    if (!env.FILES) return fail("R2 binding FILES не настроен",503);
    const object = await env.FILES.get(app.apk_key);
    if (!object) return fail("APK-файл временно недоступен",404);
    await logDownload(env,userId,appId);
    return new Response(object.body,{headers:{"content-type":"application/vnd.android.package-archive","content-disposition":`attachment; filename="${app.id}.apk"`,"content-length":String(object.size),"x-content-type-options":"nosniff","cache-control":"private, no-store","etag":object.httpEtag || ""}});
  }
  if (path === "/feedback" && method === "POST") {
    const body = await readJson(request); const message = clean(body.message,2000);
    if (message.length < 3) return fail("Сообщение слишком короткое");
    await env.DB.prepare("INSERT INTO appnest_feedback(user_id,message) VALUES (?,?)").bind(userId,message).run();
    return json({success:true},201);
  }
  if (path === "/ads" && method === "GET") {
    const {results=[]}=await env.DB.prepare("SELECT id,title,kind,creative_url,target_url FROM appnest_ad_campaigns WHERE active=1 AND starts_at<=datetime('now') AND ends_at>=datetime('now') ORDER BY priority DESC LIMIT 10").all();
    const safeAds=results.filter(ad=>validHttpUrl(ad.target_url)&&(!ad.creative_url||validHttpUrl(ad.creative_url))).slice(0,5);
    const today=new Date().toISOString().slice(0,10),shown=[];
    for(const ad of safeAds){const cap=await env.DB.prepare("SELECT impressions FROM appnest_ad_frequency WHERE user_id=? AND ad_id=? AND day=?").bind(userId,ad.id,today).first();if((cap?.impressions||0)<3)shown.push(ad);}
    return json({success:true,ads:shown});
  }
  if (path.startsWith("/ads/") && method === "POST" && /\/(impression|click)$/.test(path)) {
    const bits=path.split("/"),id=Number(bits[2]),action=bits[3],today=new Date().toISOString().slice(0,10);
    const ad=await env.DB.prepare("SELECT id FROM appnest_ad_campaigns WHERE id=? AND active=1 AND starts_at<=datetime('now') AND ends_at>=datetime('now')").bind(id).first();
    if(!ad) return fail("Реклама не найдена",404);
    if(action==="impression"){
      const changed=await env.DB.prepare("INSERT INTO appnest_ad_frequency(user_id,ad_id,day,impressions) VALUES(?,?,?,1) ON CONFLICT(user_id,ad_id,day) DO UPDATE SET impressions=impressions+1 WHERE impressions<3").bind(userId,id,today).run();
      if(!changed.meta?.changes) return json({success:true,limited:true});
      await env.DB.prepare("UPDATE appnest_ad_campaigns SET impressions=impressions+1 WHERE id=?").bind(id).run();
    }else{
      await env.DB.prepare("INSERT INTO appnest_ad_frequency(user_id,ad_id,day,clicks) VALUES(?,?,?,1) ON CONFLICT(user_id,ad_id,day) DO UPDATE SET clicks=clicks+1").bind(userId,id,today).run();
      await env.DB.prepare("UPDATE appnest_ad_campaigns SET clicks=clicks+1 WHERE id=?").bind(id).run();
    }
    return json({success:true});
  }
  if (path === "/subscription/status" && method === "GET") return json({success:true,...await subscriptionCheck(env,userId)});
  if (path.startsWith("/admin/")) {
    if(!session.isAdmin) return fail("Недостаточно прав",403);
    const admin = session;

    if(path==="/admin/subscriptions-enabled"&&method==="GET"){
      const row=await env.DB.prepare("SELECT value FROM appnest_settings WHERE key='subscriptions_enabled'").first();
      return json({success:true,enabled:row?row.value==="true":env.TELEGRAM_SUBSCRIPTIONS_ENABLED==="true"});
    }
    if(path==="/admin/subscriptions-enabled"&&method==="PUT"){
      const b=await readJson(request);if(typeof b.enabled!=="boolean")return fail("Укажите enabled: true или false");
      await env.DB.prepare("INSERT INTO appnest_settings(key,value) VALUES('subscriptions_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(b.enabled?"true":"false").run();
      await audit(env,userId,"subscription.enabled",b.enabled?"true":"false");
      return json({success:true,enabled:b.enabled});
    }
    if(path==="/admin/recovery-codes"&&method==="POST"){
      const codes=Array.from({length:8},()=>hex(crypto.getRandomValues(new Uint8Array(16))));
      await env.DB.prepare("DELETE FROM appnest_admin_recovery_codes WHERE user_id=?").bind(userId).run();
      await env.DB.batch(await Promise.all(codes.map(async code=>{
        const hash=hex(await crypto.subtle.digest("SHA-256",encoder.encode(code)));
        return env.DB.prepare("INSERT INTO appnest_admin_recovery_codes(user_id,code_hash) VALUES(?,?)").bind(userId,hash);
      })));
      await audit(env,userId,"admin.recovery_codes.rotate","8 codes");
      return json({success:true,codes,warning:"Сохраните коды сейчас. Повторно показать их нельзя."});
    }
    if(path==="/admin/recovery-codes"&&method==="DELETE"){
      await env.DB.prepare("DELETE FROM appnest_admin_recovery_codes WHERE user_id=?").bind(userId).run();
      await audit(env,userId,"admin.recovery_codes.revoke","all");
      return json({success:true});
    }
    if(path==="/admin/diagnostics"&&method==="GET"){
      const result={api:{status:"ok"},database:{status:"unknown"},storage:{status:env.FILES?"configured":"missing"},telegram:{status:env.BOT_TOKEN?"unknown":"missing"}};
      try{await env.DB.prepare("SELECT 1 AS ok").first();result.database={status:"ok"};}catch{result.database={status:"error"};}
      if(env.FILES){try{await env.FILES.head("appnest-health-check-nonexistent");result.storage={status:"ok"};}catch{result.storage={status:"error"};}}
      if(env.BOT_TOKEN){
        try{const response=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/getMe");const data=await response.json();result.telegram=data.ok?{status:"ok",username:data.result?.username||null}:{status:"error"};}
        catch{result.telegram={status:"error"};}
      }
      return json({success:true,checks:result});
    }
    if(path==="/admin/diagnostics/channel"&&method==="POST"){
      if(!env.BOT_TOKEN)return fail("BOT_TOKEN не настроен",503);
      const b=await readJson(request);
      let chat=clean(b.chat_id,120);
      chat=chat.replace("https://t.me/","").replace("http://t.me/","").replace("https://telegram.me/","").replace(/^@/,"").replace(/\/$/,"");
      if(!/^[A-Za-z0-9_]{5,32}$/.test(chat))return fail("Укажите публичный канал в формате @username или https://t.me/username");
      const [chatResponse,meResponse]=await Promise.all([
        fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/getChat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:"@"+chat})}),
        fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/getMe")
      ]);
      const [chatData,meData]=await Promise.all([chatResponse.json(),meResponse.json()]);
      if(!chatData.ok||!meData.ok)return fail("Telegram не смог открыть канал. Проверьте ссылку и доступ бота.",502);
      const memberResponse=await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/getChatMember",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatData.result.id,user_id:meData.result.id})});
      const memberData=await memberResponse.json();
      const botIsAdmin=memberData.ok&&["creator","administrator"].includes(memberData.result?.status);
      if(!botIsAdmin)return json({success:false,bot_is_admin:false,channel:{id:String(chatData.result.id),title:clean(chatData.result.title,120),username:chatData.result.username||chat},error:"Бот найден, но не является администратором канала."},409);
      await env.DB.prepare("INSERT INTO appnest_required_channels(chat_id,title,invite_url,enabled) VALUES(?,?,?,0) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,invite_url=excluded.invite_url").bind(String(chatData.result.id),clean(chatData.result.title,120),"https://t.me/"+(chatData.result.username||chat)).run();
      await audit(env,userId,"channel.verify",String(chatData.result.id),"bot admin confirmed; disabled");
      return json({success:true,bot_is_admin:true,enabled:false,channel:{id:String(chatData.result.id),title:clean(chatData.result.title,120),username:chatData.result.username||chat},message:"Канал подключён в тестовом режиме: обязательная подписка пока выключена."});
    }
    if (path === "/admin/telegram/menu-button" && method === "POST") {
      if (!env.BOT_TOKEN) return fail("BOT_TOKEN не настроен", 503);
      const telegramResponse = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/setChatMenuButton", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          menu_button: {
            type: "web_app",
            text: "Открыть APPNEST",
            web_app: { url: "https://appnest-web.anas-grow-up-3.workers.dev/" }
          }
        })
      });
      const telegramResult = await telegramResponse.json().catch(() => ({}));
      if (!telegramResponse.ok || !telegramResult.ok) {
        const retry = telegramResult.parameters?.retry_after;
        const message = clean(telegramResult.description || "Не удалось настроить кнопку Telegram", 300);
        return fail(retry ? message + " (повторите через " + retry + " сек.)" : message, telegramResponse.status === 429 ? 429 : 502);
      }
      await audit(env, userId, "telegram.menu_button", "appnest-web");
      return json({ success: true, text: "Открыть APPNEST" });
    }


    if (path === "/admin/categories" && method === "GET") {
      const {results=[]}=await env.DB.prepare("SELECT id,slug,title,icon,sort_order FROM appnest_categories ORDER BY sort_order,title").all();
      return json({success:true,categories:results});
    }
    if (path === "/admin/categories" && method === "POST") {
      const b=await readJson(request), slug=clean(b.slug,60).toLowerCase().replace(/[^a-z0-9_-]/g,"-"),title=clean(b.title,100),icon=clean(b.icon,20);
      if(!slug||!title) return fail("Укажите slug и название категории");
      await env.DB.prepare("INSERT INTO appnest_categories(slug,title,icon,sort_order) VALUES(?,?,?,?)").bind(slug,title,icon,Number(b.sort_order)||0).run();
      await audit(env,userId,"category.create",slug); return json({success:true},201);
    }
    if (path.startsWith("/admin/categories/") && method === "PATCH") {
      const id=Number(path.split("/")[3]), b=await readJson(request);
      if(!Number.isSafeInteger(id)||id<1) return fail("Некорректная категория");
      const title=clean(b.title,100),icon=clean(b.icon,20),order=Number(b.sort_order);
      if(!title) return fail("Укажите название");
      await env.DB.prepare("UPDATE appnest_categories SET title=?,icon=?,sort_order=? WHERE id=?").bind(title,icon,Number.isFinite(order)?order:0,id).run();
      await audit(env,userId,"category.update",String(id)); return json({success:true});
    }
    if (path.startsWith("/admin/categories/") && method === "DELETE") {
      const id=Number(path.split("/")[3]);
      const used=await env.DB.prepare("SELECT COUNT(*) n FROM appnest_apps WHERE category=(SELECT slug FROM appnest_categories WHERE id=?)").bind(id).first();
      if(used?.n) return fail("Категория используется приложениями",409);
      await env.DB.prepare("DELETE FROM appnest_categories WHERE id=?").bind(id).run(); await audit(env,userId,"category.delete",String(id)); return json({success:true});
    }
    if (path === "/admin/uploads" && method === "POST") {
      if(!env.FILES) return fail("R2 binding FILES не настроен",503);
      const b=await readJson(request),kind=clean(b.kind,20),size=Number(b.size_bytes),name=clean(b.filename,160),mime=clean(b.content_type,100);
      const appId=b.app_id==null?null:Number(b.app_id);
      if(b.app_id!=null&&(!Number.isSafeInteger(appId)||appId<1)) return fail("Некорректный app_id");
      const isApk=kind==="apk",isImage=["icon","banner","screenshot"].includes(kind);
      if((!isApk&&!isImage)||!Number.isSafeInteger(size)||size<(isApk?8:1)||size>Number(isApk?(env.MAX_APK_BYTES||2147483648):10485760)) return fail("Недопустимый тип или размер файла",413);
      if(isApk&&!name.toLowerCase().endsWith(".apk")) return fail("Требуется APK-файл");
      if(isImage&&!["image/png","image/jpeg","image/webp"].includes(mime)) return fail("Поддерживаются только PNG, JPEG и WebP");
      const meta={kind,filename:name,content_type:isApk?"application/vnd.android.package-archive":mime,app_id:appId,version:clean(b.version,40),version_code:Number(b.version_code)||0,min_android:clean(b.min_android,40),release_notes:clean(b.release_notes,2000),metadata:b.metadata||{}};
      if(isApk && (!meta.version || !Number.isSafeInteger(meta.version_code) || meta.version_code<1)) return fail("Укажите версию и version_code");
      if(isImage && size>10*1024*1024) return fail("Изображение превышает 10 МБ",413);
      if(appId && (!Number.isSafeInteger(appId)||appId<1)) return fail("Некорректный app_id");
      if(appId){
        const app=await env.DB.prepare("SELECT id,version_code FROM appnest_apps WHERE id=?").bind(appId).first();
        if(!app) return fail("Приложение не найдено",404);
        if(isApk&&meta.version_code<=Number(app.version_code||0)) return fail("version_code должен быть больше текущей версии",409);
      }
      const key=(isApk?"apk/":"media/")+crypto.randomUUID()+(isApk?".apk":mime==="image/png"?".png":mime==="image/webp"?".webp":".jpg");
      const mp=await createMultipart(env,key,meta.content_type),id=crypto.randomUUID(),expiry=Math.floor(Date.now()/1000)+86400;
      await env.DB.prepare("INSERT INTO appnest_upload_sessions(id,owner_id,app_id,object_key,r2_upload_id,metadata_json,expected_size,client_sha256,expires_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id,userId,appId,key,mp.uploadId,JSON.stringify(meta),size,clean(b.sha256,64).toLowerCase(),expiry).run();
      return json({success:true,upload_id:id,object_key:key,part_size:8388608,expires_at:expiry},201);
    }
    if (path.startsWith("/admin/uploads/") && path.endsWith("/parts") && method === "PUT") {
      if(!env.FILES) return fail("R2 binding FILES не настроен",503);
      const bits=path.split("/"),id=bits[3],part=Number(url.searchParams.get("part_number"));
      const session=await uploadOwner(env,id,userId);
      if(!session) return fail("Загрузка не найдена или истекла",404);
      if(!Number.isSafeInteger(part)||part<1||part>10000) return fail("Некорректный номер части");
      const partSize=8388608,expectedParts=Math.ceil(session.expected_size/partSize);
      if(part>expectedParts) return fail("Номер части превышает ожидаемое количество");
      const length=Number(request.headers.get("content-length")||0);
      const expectedLength=part===expectedParts?session.expected_size-partSize*(expectedParts-1):partSize;
      if(!length||length!==expectedLength) return fail("Размер части не совпадает с ожидаемым размером R2 multipart",413);
      const current=await env.DB.prepare("SELECT COALESCE(SUM(size_bytes),0) n FROM appnest_upload_parts WHERE upload_id=? AND part_number<>?").bind(id,part).first();
      if((current?.n||0)+length>session.expected_size) return fail("Части превышают заявленный размер",413);
      const upload=env.FILES.resumeMultipartUpload(session.object_key,session.r2_upload_id);
      const result=await upload.uploadPart(part,request.body);
      await env.DB.prepare("INSERT INTO appnest_upload_parts(upload_id,part_number,etag,size_bytes) VALUES(?,?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET etag=excluded.etag,size_bytes=excluded.size_bytes").bind(id,part,result.etag,length).run();
      return json({success:true,part_number:part,etag:result.etag,size_bytes:length});
    }
    if (path.startsWith("/admin/uploads/") && path.endsWith("/complete") && method === "POST") {
      if(!env.FILES) return fail("R2 binding FILES не настроен",503);
      const id=path.split("/")[3];
      const session=await uploadOwner(env,id,userId);
      if(!session){
        const completed=await env.DB.prepare("SELECT app_id,object_key,metadata_json FROM appnest_upload_sessions WHERE id=? AND owner_id=? AND status='completed'").bind(id,userId).first();
        if(completed){
          const meta=safeJson(completed.metadata_json);
          const app=meta.kind==="apk"&&completed.app_id
            ? await env.DB.prepare("SELECT apk_sha256 FROM appnest_apps WHERE id=?").bind(completed.app_id).first()
            : null;
          return json({success:true,app_id:completed.app_id,object_key:completed.object_key,sha256:app?.apk_sha256||null});
        }
        return fail("Загрузка не найдена или истекла",404);
      }
      const meta=safeJson(session.metadata_json);
      if(meta.kind==="apk"&&!session.app_id){
        const data=meta.metadata||{};
        if(!clean(data.title,100)||!clean(data.description,5000)||!clean(data.category,80)) return fail("Для нового приложения нужны title, description и category");
      }
      if(meta.kind!=="apk"&&!session.app_id) return fail("Для медиафайла нужен app_id");
      if(session.app_id){
        const existing=await env.DB.prepare("SELECT id FROM appnest_apps WHERE id=?").bind(session.app_id).first();
        if(!existing) return fail("Приложение не найдено",404);
      }
      const {results:parts=[]}=await env.DB.prepare("SELECT part_number,etag,size_bytes FROM appnest_upload_parts WHERE upload_id=? ORDER BY part_number").bind(id).all();
      const total=parts.reduce((n,p)=>n+p.size_bytes,0);
      if(!parts.length||total!==session.expected_size||parts.some((p,i)=>p.part_number!==i+1)) return fail("Не все части загружены или размер не совпадает",409);
      let stored=await env.FILES.get(session.object_key);
      if(!stored){
        const upload=env.FILES.resumeMultipartUpload(session.object_key,session.r2_upload_id);
        await upload.complete(parts.map(p=>({partNumber:p.part_number,etag:p.etag})));
        stored=await env.FILES.get(session.object_key);
      }
      if(!stored||stored.size!==session.expected_size){await env.FILES.delete(session.object_key);await env.DB.prepare("UPDATE appnest_upload_sessions SET status='failed' WHERE id=?").bind(id).run();return fail("Размер готового объекта не совпадает с заявленным",422);}
      let verifiedApkSha=null;
      if(meta.kind==="apk"){
        const signatureObject=await env.FILES.get(session.object_key,{range:{offset:0,length:4}});
        const sig=new Uint8Array(await signatureObject.arrayBuffer());
        if(sig.length<4||sig[0]!==0x50||sig[1]!==0x4b||sig[2]!==0x03||sig[3]!==0x04){ await env.FILES.delete(session.object_key); await env.DB.prepare("UPDATE appnest_upload_sessions SET status='failed' WHERE id=?").bind(id).run(); return fail("Файл не имеет ZIP-сигнатуру"); }
        const suppliedSha=clean(session.client_sha256,64);
        if(suppliedSha && !/^[a-f0-9]{64}$/.test(suppliedSha)){await env.FILES.delete(session.object_key);await env.DB.prepare("UPDATE appnest_upload_sessions SET status='failed' WHERE id=?").bind(id).run();return fail("Некорректный SHA-256");}
        const actualSha=await sha256Readable(stored.body);
        if(suppliedSha && actualSha!==suppliedSha){await env.FILES.delete(session.object_key);await env.DB.prepare("UPDATE appnest_upload_sessions SET status='failed' WHERE id=?").bind(id).run();return fail("SHA-256 не совпадает: файл повреждён или изменён",422);}
        const sha=actualSha; verifiedApkSha=sha;
        if(session.app_id){
          const app=await env.DB.prepare("SELECT id,apk_key FROM appnest_apps WHERE id=?").bind(session.app_id).first();
          const known=await env.DB.prepare("SELECT id FROM appnest_app_versions WHERE app_id=? AND apk_key=?").bind(session.app_id,session.object_key).first();
          if(!known) await env.DB.prepare("INSERT INTO appnest_app_versions(app_id,version,version_code,min_android,size_bytes,apk_key,sha256,release_notes) VALUES(?,?,?,?,?,?,?,?)").bind(session.app_id,meta.version,meta.version_code,meta.min_android,total,session.object_key,sha,meta.release_notes).run();
          await env.DB.prepare("UPDATE appnest_apps SET version=?,version_code=?,min_android=?,size_bytes=?,apk_key=?,apk_sha256=?,updated_at=datetime('now') WHERE id=?").bind(meta.version,meta.version_code,meta.min_android,total,session.object_key,sha,session.app_id).run();
        } else {
          const data=meta.metadata||{},title=clean(data.title,100),description=clean(data.description,5000),developer=clean(data.developer,120),category=clean(data.category,80);
          if(!title||!description||!category){ await env.FILES.delete(session.object_key); return fail("Для нового приложения нужны title, description и category"); }
          const existingApp=await env.DB.prepare("SELECT id FROM appnest_apps WHERE apk_key=?").bind(session.object_key).first();
          if(existingApp) session.app_id=existingApp.id;
          else {
            const ins=await env.DB.prepare("INSERT INTO appnest_apps(title,description,developer,category,version,version_code,min_android,size_bytes,apk_key,apk_sha256,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(title,description,developer,category,meta.version,meta.version_code,meta.min_android,total,session.object_key,sha,"draft",userId).run();
            session.app_id=ins.meta.last_row_id;
          }
          await env.DB.prepare("UPDATE appnest_upload_sessions SET app_id=? WHERE id=?").bind(session.app_id,id).run();
          const known=await env.DB.prepare("SELECT id FROM appnest_app_versions WHERE app_id=? AND apk_key=?").bind(session.app_id,session.object_key).first();
          if(!known) await env.DB.prepare("INSERT INTO appnest_app_versions(app_id,version,version_code,min_android,size_bytes,apk_key,sha256,release_notes) VALUES(?,?,?,?,?,?,?,?)").bind(session.app_id,meta.version,meta.version_code,meta.min_android,total,session.object_key,sha,meta.release_notes).run();
        }
      } else {
        const sampleObject=await env.FILES.get(session.object_key,{range:{offset:0,length:12}});
        const sample=new Uint8Array(await sampleObject.arrayBuffer());
        const isPng=sample.length>=8&&sample[0]===137&&sample[1]===80&&sample[2]===78&&sample[3]===71&&sample[4]===13&&sample[5]===10&&sample[6]===26&&sample[7]===10;
        const isJpeg=sample[0]===255&&sample[1]===216&&sample[2]===255;
        const isWebp=sample.length>=12&&String.fromCharCode(...sample.slice(0,4))==="RIFF"&&String.fromCharCode(...sample.slice(8,12))==="WEBP";
        const mimeMatches=(meta.content_type==="image/png"&&isPng)||(meta.content_type==="image/jpeg"&&isJpeg)||(meta.content_type==="image/webp"&&isWebp);
        if(!mimeMatches){await env.FILES.delete(session.object_key);await env.DB.prepare("UPDATE appnest_upload_sessions SET status='failed' WHERE id=?").bind(id).run();return fail("Содержимое файла не соответствует заявленному MIME-типу");}
        const column=meta.kind==="icon"?"icon_key":meta.kind==="banner"?"banner_key":null;
        if(column) await env.DB.prepare("UPDATE appnest_apps SET "+column+"=?,updated_at=datetime('now') WHERE id=?").bind(session.object_key,session.app_id).run();
        else {
          const row=await env.DB.prepare("SELECT screenshots_json FROM appnest_apps WHERE id=?").bind(session.app_id).first();
          const list=safeArray(row?.screenshots_json); if(!list.includes(session.object_key)) list.push(session.object_key);
          await env.DB.prepare("UPDATE appnest_apps SET screenshots_json=?,updated_at=datetime('now') WHERE id=?").bind(JSON.stringify(list.slice(-10)),session.app_id).run();
        }
      }
      await env.DB.prepare("UPDATE appnest_upload_sessions SET status='completed' WHERE id=?").bind(id).run();
      try{await audit(env,userId,"upload.complete",id,meta.kind);}catch(error){console.warn("Upload audit event was not saved:",error?.message||"audit failed");}
      return json({success:true,app_id:session.app_id,object_key:session.object_key,sha256:verifiedApkSha});
    }
    if (path.startsWith("/admin/uploads/") && method === "DELETE") {
      const id=path.split("/")[3],session=await env.DB.prepare("SELECT * FROM appnest_upload_sessions WHERE id=? AND owner_id=? AND status='open'").bind(id,userId).first();
      if(!session) return fail("Загрузка не найдена",404);
      try{await env.FILES.resumeMultipartUpload(session.object_key,session.r2_upload_id).abort();}catch(error){console.warn("R2 multipart abort:",error?.message||"failed");}
      await env.DB.prepare("UPDATE appnest_upload_sessions SET status='aborted' WHERE id=? AND owner_id=? AND status='open'").bind(id,userId).run();
      return json({success:true});
    }
    if (path.startsWith("/admin/apps/") && path.endsWith("/versions") && method === "GET") {
      const id=Number(path.split("/")[3]);
      const {results=[]}=await env.DB.prepare("SELECT id,version,version_code,min_android,size_bytes,sha256,release_notes,created_at FROM appnest_app_versions WHERE app_id=? ORDER BY version_code DESC").bind(id).all();
      return json({success:true,versions:results});
    }
    if (path.startsWith("/admin/channels/") && method === "PATCH") {
      const id=Number(path.split("/")[3]),b=await readJson(request);
      if(typeof b.enabled!=="boolean") return fail("enabled должен быть boolean");
      await env.DB.prepare("UPDATE appnest_required_channels SET enabled=? WHERE id=?").bind(b.enabled?1:0,id).run(); await audit(env,userId,"channel.toggle",String(id)); return json({success:true});
    }
    if (path.startsWith("/admin/channels/") && method === "DELETE") {
      const id=Number(path.split("/")[3]); await env.DB.prepare("DELETE FROM appnest_required_channels WHERE id=?").bind(id).run(); await audit(env,userId,"channel.delete",String(id)); return json({success:true});
    }
    if (path.startsWith("/admin/ads/") && method === "PATCH") {
      const id=Number(path.split("/")[3]),b=await readJson(request);
      if(!Number.isSafeInteger(id)||id<1) return fail("Некорректная кампания");
      if(Object.keys(b).length===1&&typeof b.active==="boolean"){
        await env.DB.prepare("UPDATE appnest_ad_campaigns SET active=? WHERE id=?").bind(b.active?1:0,id).run();
        await audit(env,userId,"ad.toggle",String(id)); return json({success:true});
      }
      const title=clean(b.title,120),kind=clean(b.kind,40),creative=clean(b.creative_url,1000),target=clean(b.target_url,1000),starts=clean(b.starts_at,40),ends=clean(b.ends_at,40);
      if(!title||!["banner","channel","task"].includes(kind)||!validHttpUrl(target)||(creative&&!validHttpUrl(creative))||!starts||!ends||!Number.isFinite(Date.parse(starts))||!Number.isFinite(Date.parse(ends))||new Date(starts)>=new Date(ends)) return fail("Некорректные параметры кампании");
      await env.DB.prepare("UPDATE appnest_ad_campaigns SET title=?,kind=?,creative_url=?,target_url=?,starts_at=?,ends_at=?,priority=? WHERE id=?").bind(title,kind,creative,target,starts,ends,Number(b.priority)||0,id).run();
      await audit(env,userId,"ad.update",String(id)); return json({success:true});
    }
    if (path.startsWith("/admin/ads/") && method === "DELETE") {
      const id=Number(path.split("/")[3]); await env.DB.prepare("DELETE FROM appnest_ad_campaigns WHERE id=?").bind(id).run(); await audit(env,userId,"ad.delete",String(id)); return json({success:true});
    }
    if (path === "/admin/notifications" && method === "GET") {
      const {results=[]}=await env.DB.prepare("SELECT id,title,message,active,created_at FROM appnest_notifications ORDER BY created_at DESC LIMIT 100").all();
      return json({success:true,notifications:results});
    }
    if (path.startsWith("/admin/notifications/") && method === "PATCH") {
      const id=Number(path.split("/")[3]),b=await readJson(request);
      if(typeof b.active!=="boolean") return fail("active должен быть boolean");
      await env.DB.prepare("UPDATE appnest_notifications SET active=? WHERE id=?").bind(b.active?1:0,id).run(); await audit(env,userId,"notification.toggle",String(id)); return json({success:true});
    }
    if (path.startsWith("/admin/feedback/") && method === "PATCH") {
      const id=Number(path.split("/")[3]),b=await readJson(request);
      if(!["open","resolved","rejected"].includes(b.status)) return fail("Недопустимый статус");
      await env.DB.prepare("UPDATE appnest_feedback SET status=? WHERE id=?").bind(b.status,id).run(); await audit(env,userId,"feedback.update",String(id)); return json({success:true});
    }

    if (path === "/admin/users" && method === "GET") {
      const {results=[]}=await env.DB.prepare("SELECT telegram_id,username,first_name,is_blocked,created_at,last_seen_at AS last_seen FROM users ORDER BY last_seen_at DESC LIMIT 200").all();
      return json({success:true,users:results});
    }
    if (path === "/admin/overview" && method === "GET") {
      const [apps,users,downloads,feedback,allApps,ads,channels,frequency,mode] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) n FROM appnest_apps WHERE status='published'").first(),
        env.DB.prepare("SELECT COUNT(*) n FROM users").first(),
        env.DB.prepare("SELECT COUNT(*) n FROM appnest_downloads").first(),
        env.DB.prepare("SELECT id,user_id,message,created_at FROM appnest_feedback WHERE status='open' ORDER BY created_at DESC LIMIT 50").all(),
        env.DB.prepare("SELECT id,title,description,category,version,downloads,status FROM appnest_apps ORDER BY created_at DESC LIMIT 100").all(),
        env.DB.prepare("SELECT id,title,kind,creative_url,target_url,active,starts_at,ends_at,priority,impressions,clicks FROM appnest_ad_campaigns ORDER BY id DESC LIMIT 50").all(),
        env.DB.prepare("SELECT id,chat_id,title,invite_url,enabled FROM appnest_required_channels ORDER BY id").all(),
        env.DB.prepare("SELECT substr(created_at,1,10) day,COUNT(*) count FROM appnest_downloads GROUP BY substr(created_at,1,10) ORDER BY day DESC LIMIT 14").all(),
        env.DB.prepare("SELECT value FROM appnest_settings WHERE key='subscription_mode'").first()
      ]);
      return json({success:true,apps_count:apps.n,users_count:users.n,downloads_count:downloads.n,feedback:feedback.results,apps:allApps.results,ads:ads.results,channels:channels.results,downloads_by_day:frequency.results,subscription_mode:mode?.value||"all"});
    }
    if (path === "/admin/apps" && method === "POST") {
      const form=await request.formData(); const title=clean(form.get("title"),100), description=clean(form.get("description"),5000), developer=clean(form.get("developer"),120), category=clean(form.get("category"),80), version=clean(form.get("version"),40), minAndroid=clean(form.get("min_android"),40);
      const apk=form.get("apk"), icon=form.get("icon");
      if(!title || !description || !category || !(apk instanceof File) || apk.size<8 || !apk.name.toLowerCase().endsWith(".apk")) return fail("Укажите название, описание, категорию и корректный APK");
      if(apk.size>Number(env.MAX_DIRECT_APK_BYTES || 16777216)) return fail("Для файлов больше 16 МиБ используйте multipart-загрузку",413);
      const head=new Uint8Array(await apk.slice(0,4).arrayBuffer()); if(head.length<4||head[0]!==0x50||head[1]!==0x4b||head[2]!==0x03||head[3]!==0x04) return fail("APK не имеет ZIP-сигнатуру");
      if(!env.FILES) return fail("R2 binding FILES не настроен",503);
      const bytes=await apk.arrayBuffer(); const digest=hex(await crypto.subtle.digest("SHA-256",bytes)); const key="apk/"+crypto.randomUUID()+".apk";
      await env.FILES.put(key,bytes,{httpMetadata:{contentType:"application/vnd.android.package-archive"}});
      let iconKey=null;
      if(icon instanceof File && icon.size>0) {
        if(icon.size>2*1024*1024 || !/^image\/(png|jpeg|webp)$/.test(icon.type)) { await env.FILES.delete(key); return fail("Недопустимая иконка"); }
        const iconBytes=await icon.arrayBuffer(),sig=new Uint8Array(iconBytes.slice(0,12));
        const png=sig.length>=8&&sig[0]===137&&sig[1]===80&&sig[2]===78&&sig[3]===71&&sig[4]===13&&sig[5]===10&&sig[6]===26&&sig[7]===10;
        const jpeg=sig[0]===255&&sig[1]===216&&sig[2]===255;
        const webp=sig.length>=12&&String.fromCharCode(...sig.slice(0,4))==="RIFF"&&String.fromCharCode(...sig.slice(8,12))==="WEBP";
        if(!(png||jpeg||webp)) { await env.FILES.delete(key); return fail("Содержимое иконки не соответствует MIME-типу"); }
        iconKey="icons/"+crypto.randomUUID(); await env.FILES.put(iconKey,iconBytes,{httpMetadata:{contentType:icon.type}});
      }
      let createdAppId=null;
      try {
        const inserted=await env.DB.prepare("INSERT INTO appnest_apps(title,description,developer,category,version,min_android,size_bytes,apk_key,apk_sha256,icon_key,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(title,description,developer,category,version,minAndroid,apk.size,key,digest,iconKey,"published",userId).run();
        createdAppId=inserted.meta.last_row_id;
        await env.DB.prepare("INSERT INTO appnest_app_versions(app_id,version,version_code,min_android,size_bytes,apk_key,sha256,release_notes) VALUES(?,?,?,?,?,?,?,?)").bind(createdAppId,version,0,minAndroid,apk.size,key,digest,"").run();
      } catch(error) {
        if(createdAppId) await env.DB.prepare("DELETE FROM appnest_apps WHERE id=?").bind(createdAppId).run();
        await env.FILES.delete(key); if(iconKey) await env.FILES.delete(iconKey); throw error;
      }
      try{await audit(env,userId,"app.create",String(createdAppId),`sha256=${digest}`);}catch(error){console.warn("App audit event was not saved:",error?.message||"audit failed");}
      return json({success:true,id:createdAppId,sha256:digest,size_bytes:apk.size},201);
    }
    if (path.startsWith("/admin/apps/") && method === "PATCH") {
      const id=Number(path.split("/")[3]); const body=await readJson(request);
      const fields={title:"title",description:"description",developer:"developer",category:"category",version:"version",min_android:"min_android",status:"status"};
      const sets=[],values=[];
      for(const [key,col] of Object.entries(fields)) if(body[key]!==undefined){ const value=clean(body[key],key==="description"?5000:200); if(key==="status"&&!["draft","published","archived"].includes(value)) return fail("Недопустимый статус"); sets.push(col+"=?"); values.push(value); }
      if(!sets.length) return fail("Нет изменений");
      values.push(id); await env.DB.prepare("UPDATE appnest_apps SET "+sets.join(",")+",updated_at=datetime('now') WHERE id=?").bind(...values).run(); await audit(env,userId,"app.update",String(id)); return json({success:true});
    }
    if (path === "/admin/channels" && method === "POST") {
      const b=await readJson(request); const chatId=clean(String(b.chat_id||""),120),title=clean(b.title,120),invite=clean(b.invite_url,500);
      if(!chatId||!title||!/^https:\/\/(t\.me|telegram\.me)\//.test(invite)) return fail("Проверьте chat_id, название и ссылку канала");
      await env.DB.prepare("INSERT INTO appnest_required_channels(chat_id,title,invite_url,enabled) VALUES(?,?,?,1)").bind(chatId,title,invite).run(); await audit(env,userId,"channel.create",chatId); return json({success:true},201);
    }
    if (path === "/admin/subscription-mode" && method === "PUT") {
      const b=await readJson(request); if(!["all","any"].includes(b.mode)) return fail("Режим должен быть all или any");
      await env.DB.prepare("INSERT INTO appnest_settings(key,value) VALUES('subscription_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(b.mode).run(); await audit(env,userId,"subscription.mode",b.mode); return json({success:true});
    }
    if (path === "/admin/ads" && method === "POST") {
      const b=await readJson(request); const title=clean(b.title,120),kind=clean(b.kind,40),creative=clean(b.creative_url,1000),target=clean(b.target_url,1000),starts=clean(b.starts_at,40),ends=clean(b.ends_at,40);
      if(!title||!["banner","channel","task"].includes(kind)||!validHttpUrl(target)||(creative&&!validHttpUrl(creative))||!starts||!ends||!Number.isFinite(Date.parse(starts))||!Number.isFinite(Date.parse(ends))||new Date(starts)>=new Date(ends)) return fail("Некорректные параметры кампании");
      await env.DB.prepare("INSERT INTO appnest_ad_campaigns(title,kind,creative_url,target_url,starts_at,ends_at,active,priority) VALUES(?,?,?,?,?,?,?,?)").bind(title,kind,creative,target,starts,ends,b.active===false?0:1,Number(b.priority)||0).run(); await audit(env,userId,"ad.create",title); return json({success:true},201);
    }
    if (path.startsWith("/admin/users/") && method === "PATCH") {
      const id=path.split("/")[3]; const b=await readJson(request); if(!/^\d+$/.test(id)||typeof b.blocked!=="boolean") return fail("Некорректные данные");
      await env.DB.prepare("UPDATE users SET is_blocked=? WHERE telegram_id=?").bind(b.blocked?1:0,id).run(); await audit(env,userId,b.blocked?"user.block":"user.unblock",id); return json({success:true});
    }
    if (path === "/admin/notifications" && method === "POST") {
      const b=await readJson(request); const title=clean(b.title,120),message=clean(b.message,2000); if(!title||!message) return fail("Заполните заголовок и сообщение");
      await env.DB.prepare("INSERT INTO appnest_notifications(title,message,active) VALUES(?,?,1)").bind(title,message).run(); await audit(env,userId,"notification.create",title); return json({success:true},201);
    }
    if (path === "/admin/feedback" && method === "GET") {
      const {results=[]}=await env.DB.prepare("SELECT * FROM appnest_feedback ORDER BY created_at DESC LIMIT 200").all(); return json({success:true,feedback:results});
    }
    if (path === "/admin/audit" && method === "GET") {
      const {results=[]}=await env.DB.prepare("SELECT actor_id,action,target,details,created_at FROM appnest_admin_audit ORDER BY id DESC LIMIT 200").all(); return json({success:true,events:results});
    }
    return fail("Endpoint not found",404);
  }
  return fail("Endpoint not found",404);
}
async function cleanupExpired(env) {
  if(!env.DB) return;
  const now=Math.floor(Date.now()/1000);
  const {results=[]}=await env.DB.prepare("SELECT id,object_key,r2_upload_id FROM appnest_upload_sessions WHERE status='open' AND expires_at<=? LIMIT 100").bind(now).all();
  for(const session of results){
    if(env.FILES){
      try{await env.FILES.resumeMultipartUpload(session.object_key,session.r2_upload_id).abort();}
      catch(error){console.warn("Expired multipart cleanup:",error?.message||"abort failed");}
    }
    await env.DB.prepare("UPDATE appnest_upload_sessions SET status='failed' WHERE id=? AND status='open'").bind(session.id).run();
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM appnest_download_tokens WHERE expires_at<? OR used_at IS NOT NULL").bind(now),
    env.DB.prepare("DELETE FROM appnest_auth_sessions WHERE expires_at<?").bind(now),
    env.DB.prepare("DELETE FROM appnest_rate_limits WHERE expires_at<?").bind(now),
    env.DB.prepare("DELETE FROM appnest_ad_frequency WHERE day<date('now','-90 days')"),
    env.DB.prepare("DELETE FROM appnest_upload_sessions WHERE status IN ('completed','aborted','failed') AND created_at<datetime('now','-30 days')")
  ]);
}
function safeArray(value) { try { const x=JSON.parse(value||"[]"); return Array.isArray(x)?x:[]; } catch { return []; } }
export { sha256Readable, cleanupExpired, mediaObject };
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanupExpired(env));
  },
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowedOrigins = [...(env.ALLOWED_ORIGINS || "").split(","), ...(env.ALLOWED_ORIGIN || "").split(","), "https://appnest-web.anas-grow-up-3.workers.dev"]
      .map(value => value.trim()).filter(Boolean);
    const cors = { "vary": "Origin", "access-control-allow-credentials": "true" };
    if (origin && allowedOrigins.includes(origin)) cors["access-control-allow-origin"] = origin;
    if (!["GET","HEAD","OPTIONS"].includes(request.method) && origin && !allowedOrigins.includes(origin)) {
      return new Response(JSON.stringify({success:false,error:"Origin not allowed"}),{status:403,headers:JSON_HEADERS});
    }
    try {
      const response = await handle(request,env);
      const headers = new Headers(response.headers);
      headers.delete("access-control-allow-origin");
      for (const [k,v] of Object.entries(cors)) headers.set(k,v);
      return new Response(response.body,{status:response.status,headers});
    } catch (error) {
      const status=error?.status===413?413:error?.status===400?400:500;
      if(status===500) console.error("APPNEST API error:", error?.message || "internal error");
      const message=status===500?"Внутренняя ошибка сервера":(error?.message||"Некорректный запрос");
      return new Response(JSON.stringify({success:false,error:message}),{status,headers:{...JSON_HEADERS,...cors}});
    }
  }
};
