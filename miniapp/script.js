(() => {
  "use strict";

  const API = "https://appnest-api.anas-grow-up-3.workers.dev/api";
  const PAGE_SIZE = 12;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const tg = window.Telegram?.WebApp;
  tg?.ready();
  tg?.expand();

  const state = {
    page: "home",
    apps: [],
    filtered: [],
    selectedApp: null,
    favorites: new Set(),
    history: [],
    notifications: [],
    user: null,
    isAdmin: false,
    language: "ru",
    category: "all",
    search: "",
    sort: "popular",
    pageNumber: 1,
    loading: false
  };

  const initData = tg?.initData || "";


  function setUploadProgress(done,total,label="Загрузка") {
    const bar=$("#uploadProgress"),status=$("#uploadStatus");
    if(bar) bar.value=total?Math.min(100,Math.round(done/total*100)):0;
    if(status) status.textContent=label+" · "+(total?Math.round(done/total*100):0)+"%";
  }
  function sendUploadPart(uploadId,partNumber,bytes,onProgress) {
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open("PUT",API+`/admin/uploads/${encodeURIComponent(uploadId)}/parts?part_number=${partNumber}`);
      xhr.setRequestHeader("X-Telegram-Init-Data",initData);
      xhr.setRequestHeader("Content-Type","application/octet-stream");
      xhr.upload.onprogress=e=>{if(e.lengthComputable) onProgress(e.loaded,e.total);};
      xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText);}catch{} if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(new Error(data.error||"Ошибка части "+partNumber));};
      xhr.onerror=()=>reject(new Error("Сетевая ошибка при загрузке части "+partNumber));
      xhr.onabort=()=>reject(new Error("Загрузка отменена"));
      xhr.send(bytes);
    });
  }
  async function uploadFileMultipart(file,kind,extra={},onProgress=()=>{}) {
    const init=await request("/admin/uploads",{method:"POST",body:JSON.stringify({
      kind,filename:file.name,size_bytes:file.size,content_type:file.type||"application/octet-stream",
      ...extra
    })});
    const chunkSize=init.part_size||8388608, count=Math.ceil(file.size/chunkSize);
    let sent=0;
    try {
      for(let part=1;part<=count;part++){
        const chunk=file.slice((part-1)*chunkSize,Math.min(part*chunkSize,file.size));
        let done=false,error;
        for(let attempt=0;attempt<3&&!done;attempt++){
          try {
            await sendUploadPart(init.upload_id,part,chunk,(loaded)=>{
              const current=sent+Math.min(loaded,chunk.size);
              onProgress(current,file.size);
            });
            done=true;sent+=chunk.size;onProgress(sent,file.size);
          } catch(e){error=e;if(attempt<2) await new Promise(r=>setTimeout(r,500*(attempt+1)));}
        }
        if(!done) throw error||new Error("Не удалось загрузить часть "+part);
      }
      const completed=await request("/admin/uploads/"+encodeURIComponent(init.upload_id)+"/complete",{method:"POST",body:JSON.stringify({})});
      return completed;
    } catch(error) {
      await request("/admin/uploads/"+encodeURIComponent(init.upload_id),{method:"DELETE"}).catch(()=>{});
      throw error;
    }
  }

  async function request(path, options = {}) {
    const response = await fetch(API + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Init-Data": initData,
        ...(options.headers || {})
      }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Ошибка сервера (${response.status})`);
    }

    return data;
  }

  function escapeHTML(value = "") {
    return String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[char]);
  }

  function toast(message) {
    const container = $("#toastContainer");
    if (!container) return;

    const item = document.createElement("div");
    item.className = "toast";
    item.textContent = message;
    container.append(item);

    setTimeout(() => item.remove(), 3200);
  }

  function navigate(page) {
    const target = $(`#page-${page}`);
    if (!target) return;

    state.page = page;

    $$(".page").forEach(el => el.classList.toggle(
      "active",
      el.id === `page-${page}`
    ));

    $$(".nav-item").forEach(el => el.classList.toggle(
      "active",
      el.dataset.page === page
    ));

    const nav = $("#bottomNav");
    if (nav) nav.hidden = ["details", "admin", "history", "notifications"].includes(page);

    window.scrollTo({ top: 0, behavior: "smooth" });

    if (page === "favorites") renderFavorites();
    if (page === "profile") renderProfile();
    if (page === "history") renderHistory();
    if (page === "notifications") renderNotifications();
    if (page === "catalog") renderCatalog();
    if (page === "admin" && state.isAdmin) loadAdmin();
  }

  function appCard(app) {
    const id = escapeHTML(app.id ?? app.code ?? "");
    const title = escapeHTML(app.title || "Без названия");
    const description = escapeHTML(app.description || "");
    const icon = app.icon_url
      ? `<img src="${escapeHTML(new URL(app.icon_url, API).href)}" alt="" loading="lazy">`
      : `<span>${escapeHTML((app.title || "A").charAt(0).toUpperCase())}</span>`;

    const favorite = state.favorites.has(String(id));

    return `
      <article class="app-card" data-app-id="${id}">
        <button class="app-card-main" data-open-app="${id}">
          <div class="app-icon">${icon}</div>
          <div class="app-card-info">
            <h3>${title}</h3>
            <p>${description}</p>
            <span class="app-meta">
              ${escapeHTML(app.category || "Приложение")}
              ${app.version ? " · v" + escapeHTML(app.version) : ""}
            </span>
          </div>
        </button>
        <button class="favorite-button ${favorite ? "active" : ""}"
          data-favorite="${id}" aria-label="В избранное">
          ${favorite ? "♥" : "♡"}
        </button>
      </article>`;
  }

  function renderList(element, apps) {
    if (!element) return;

    if (!apps.length) {
      element.innerHTML = '<div class="empty-message">Пока приложений нет.</div>';
      return;
    }

    element.innerHTML = apps.map(appCard).join("");
  }

  async function loadApps() {
    try {
      state.loading = true;

      const data = await request("/apps");
      state.apps = Array.isArray(data) ? data : (data.apps || []);

      renderHome();
      renderCatalog();
    } catch (error) {
      console.error("APPNEST apps:", error);
      ["popularApps", "recentApps", "catalogApps"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML =
          '<div class="empty-message">Не удалось загрузить каталог. Проверьте подключение и повторите попытку.</div>';
      });
    } finally {
      state.loading = false;
      $("#loadingScreen")?.classList.add("hidden");
    }
  }

  async function loadAds() {
    const slot=$("#adSlot");if(!slot||!initData)return;
    try{
      const data=await request("/ads"),ads=data.ads||[];
      if(!ads.length){slot.hidden=true;slot.innerHTML="";return;}
      slot.hidden=false;
      slot.innerHTML=ads.map(ad=>`<a class="ad-card" href="${escapeHTML(ad.target_url)}" target="_blank" rel="noopener noreferrer" data-ad-click="${ad.id}">
        <span class="ad-label">Реклама</span>${ad.creative_url?'<img src="'+escapeHTML(ad.creative_url)+'" alt="" loading="lazy">':""}
        <strong>${escapeHTML(ad.title)}</strong><span>Подробнее ↗</span></a>`).join("");
      for(const ad of ads) request("/ads/"+ad.id+"/impression",{method:"POST",body:JSON.stringify({})}).catch(()=>{});
    }catch(error){console.warn("APPNEST ads:",error.message);slot.hidden=true;}
  }

  function renderHome() {
    const popular = [...state.apps]
      .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
      .slice(0, 5);

    const recent = [...state.apps]
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 5);

    renderList($("#popularApps"), popular);
    renderList($("#recentApps"), recent);
  }

  function filterApps() {
    let result = [...state.apps];

    if (state.search) {
      const query = state.search.toLowerCase();
      result = result.filter(app =>
        `${app.title || ""} ${app.description || ""} ${app.category || ""}`
          .toLowerCase().includes(query)
      );
    }

    if (state.category !== "all") {
      result = result.filter(app => app.category === state.category);
    }

    if (state.sort === "popular") {
      result.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    } else if (state.sort === "newest") {
      result.sort((a, b) =>
        new Date(b.created_at || 0) - new Date(a.created_at || 0)
      );
    } else if (state.sort === "name") {
      result.sort((a, b) =>
        (a.title || "").localeCompare(b.title || "")
      );
    }

    return result;
  }

  function renderCatalog() {
    state.filtered = filterApps();

    const count = $("#catalogResultsCount");
    if (count) count.textContent = `Найдено: ${state.filtered.length}`;

    const start = (state.pageNumber - 1) * PAGE_SIZE;
    const visible = state.filtered.slice(start, start + PAGE_SIZE);

    renderList($("#catalogApps"), visible);

    const empty = $("#catalogEmpty");
    if (empty) empty.hidden = state.filtered.length !== 0;

    const more = $("#loadMoreButton");
    if (more) more.hidden = start + PAGE_SIZE >= state.filtered.length;
  }

  function openDetails(id) {
    const app = state.apps.find(item =>
      String(item.id ?? item.code) === String(id)
    );

    if (!app) return toast("Приложение не найдено");

    state.selectedApp = app;

    const icon = app.icon_url
      ? `<img src="${escapeHTML(new URL(app.icon_url, API).href)}" alt="">`
      : `<span>${escapeHTML((app.title || "A")[0])}</span>`;

    $("#appDetailsContent").innerHTML = `
      <div class="details-hero">
        <div class="app-icon large">${icon}</div>
        <h1>${escapeHTML(app.title)}</h1>
        <p>${escapeHTML(app.category || "Приложение")}</p>
        <p>${escapeHTML(app.description || "")}</p>
        <div class="details-meta">
          <span>Версия: ${escapeHTML(app.version || "—")}</span>
          <span>Размер: ${escapeHTML(app.size || "—")}</span>
        </div>
        <button class="primary-button full-button" data-download="${escapeHTML(app.id ?? app.code)}">
          Скачать приложение
        </button>
        <button class="secondary-button full-button" data-favorite="${escapeHTML(app.id ?? app.code)}">
          ${state.favorites.has(String(app.id ?? app.code)) ? "Убрать из избранного" : "В избранное"}
        </button>
      </div>
      ${app.banner_url ? `<img class="details-banner" src="${escapeHTML(new URL(app.banner_url,API).href)}" alt="" loading="lazy">` : ""}
      ${app.screenshots?.length ? `
        <div class="screenshots">
          ${app.screenshots.map(src =>
            `<img src="${escapeHTML(new URL(src,API).href)}" loading="lazy" alt="Скриншот приложения">`
          ).join("")}
        </div>` : ""}
      ${app.release_notes ? `
        <div class="release-notes">
          <h3>Что нового</h3>
          <p>${escapeHTML(app.release_notes)}</p>
        </div>` : ""}
    `;

    navigate("details");
    request("/apps/"+encodeURIComponent(id)+"/versions").then(data=>{const host=$("#appDetailsContent");if(!host||!data.versions?.length)return;const section=document.createElement("section");section.className="release-notes";section.innerHTML="<h3>История версий</h3>"+data.versions.map(v=>`<p><strong>v${escapeHTML(v.version)}</strong> · ${escapeHTML(v.created_at||"")}<br>${escapeHTML(v.release_notes||"")}</p>`).join("");host.append(section);}).catch(()=>{});
  }

  async function downloadApp(id) {
    try {
      const response=await fetch(API+`/apps/${encodeURIComponent(id)}/download-ticket`,{
        method:"POST",headers:{"X-Telegram-Init-Data":initData}
      });
      const type=response.headers.get("content-type")||"";
      const data=type.includes("application/json")?await response.json().catch(()=>({})):{};
      if(!response.ok){
        if(data.subscription_required){
          const channels=(data.channels||[]).map(channel=>`<p>${escapeHTML(channel.title)} — ${channel.subscribed?"✓ подписка есть":"подпишитесь"}</p>
            <a class="secondary-button full-button" href="${escapeHTML(channel.invite_url)}" target="_blank" rel="noopener">Открыть канал</a>`).join("");
          openModal(`<h2>Подписка на каналы</h2><p>Для скачивания выполните условия подписки, затем повторите проверку.</p>${channels}<button class="primary-button full-button" data-retry-download="${escapeHTML(id)}">Проверить снова</button>`);
        }
        throw new Error(data.error||"Не удалось получить защищённую ссылку");
      }
      if(!data.url)throw new Error("Ссылка на скачивание не получена");
      const anchor=document.createElement("a");
      anchor.href=new URL(data.url,API).href;
      anchor.download="";
      anchor.rel="noopener";
      document.body.append(anchor);anchor.click();anchor.remove();
      setTimeout(()=>loadProfileData(),2500);
    }catch(error){toast(error.message||"Не удалось скачать приложение");}
  }

  async function toggleFavorite(id) {
    const key = String(id);
    const wasFavorite = state.favorites.has(key);

    try {
      await request(`/favorites/${encodeURIComponent(key)}`, {
        method: wasFavorite ? "DELETE" : "POST",
        body: JSON.stringify({})
      });

      if (wasFavorite) state.favorites.delete(key);
      else state.favorites.add(key);

      renderCatalog();
      renderHome();
      renderFavorites();
      renderProfile();
    } catch (error) {
      toast(error.message || "Не удалось изменить избранное");
    }
  }

  function renderFavorites() {
    const apps = state.apps.filter(app =>
      state.favorites.has(String(app.id ?? app.code))
    );

    renderList($("#favoriteApps"), apps);

    const empty = $("#favoritesEmpty");
    if (empty) empty.hidden = apps.length > 0;
  }

  function renderProfile() {
    const user = state.user || tg?.initDataUnsafe?.user || {};
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Пользователь";

    $("#profileName") && ($("#profileName").textContent = name);
    $("#profileUsername") && ($("#profileUsername").textContent =
      user.username ? "@" + user.username : "Telegram user");

    const letter = name.charAt(0).toUpperCase();
    $("#headerAvatarLetter") && ($("#headerAvatarLetter").textContent = letter);
    $("#profileAvatarLetter") && ($("#profileAvatarLetter").textContent = letter);

    const avatar = user.photo_url;
    ["headerAvatarImage", "profileAvatarImage"].forEach(id => {
      const img = document.getElementById(id);
      if (img && avatar) {
        img.src = avatar;
        img.hidden = false;
      }
    });

    $("#favoriteCount") && ($("#favoriteCount").textContent = state.favorites.size);
    $("#downloadCount") && ($("#downloadCount").textContent = state.history.length);
    $("#adminEntry") && ($("#adminEntry").hidden = !state.isAdmin);
  }

  async function loadProfileData() {
    try {
      const data = await request("/me");
      state.language = data.language || state.language || "ru";
      if($("#languageSelect")) $("#languageSelect").value=state.language;
      state.user = data.user || null;
      state.isAdmin = data.is_admin === true;
      state.favorites = new Set((data.favorites || []).map(String));
      state.history = data.history || [];
      state.notifications = data.notifications || [];
      renderProfile();
    } catch (error) {
      console.error("APPNEST profile:", error);
    }
  }

  function renderHistory() {
    const element = $("#downloadHistory");
    if (!element) return;

    if (!state.history.length) {
      element.innerHTML = "";
      $("#historyEmpty") && ($("#historyEmpty").hidden = false);
      return;
    }

    $("#historyEmpty") && ($("#historyEmpty").hidden = true);

    element.innerHTML = state.history.map(item => `
      <article class="app-card">
        <div class="app-card-info">
          <h3>${escapeHTML(item.title || "Приложение")}</h3>
          <p>${item.date ? new Date(item.date).toLocaleString() : ""}</p>
        </div>
      </article>
    `).join("");
  }

  function renderNotifications() {
    const element = $("#notificationList");
    if (!element) return;

    const items = state.notifications;
    $("#notificationsEmpty") && ($("#notificationsEmpty").hidden = items.length > 0);

    element.innerHTML = items.map(item => `
      <article class="notification-item">
        <h3>${escapeHTML(item.title || "Обновление")}</h3>
        <p>${escapeHTML(item.message || "")}</p>
        <small>${item.created_at ? new Date(item.created_at).toLocaleString() : ""}</small>
      </article>
    `).join("");
  }

  function openModal(content) {
    $("#modalContent").innerHTML = content;
    $("#modalOverlay").hidden = false;
  }

  function closeModal() {
    $("#modalOverlay").hidden = true;
    $("#modalContent").innerHTML = "";
  }

  async function loadAdmin() {
    if (!state.isAdmin) return navigate("home");
    try {
      const [data,categories,users,notifications,feedback,audit]=await Promise.all([request("/admin/overview"),request("/admin/categories"),request("/admin/users"),request("/admin/notifications"),request("/admin/feedback"),request("/admin/audit")]);
      $("#adminAppsCount").textContent=data.apps_count??"—";
$("#adminUsersCount").textContent=data.users_count??"—";$("#adminDownloadsCount").textContent=data.downloads_count??"—";
      $("#adminAppsList").innerHTML=(data.apps||[]).map(app=>`
        <article class="app-card admin-app-row"><div class="app-card-info"><h3>${escapeHTML(app.title)}</h3><p>${escapeHTML(app.category)} · v${escapeHTML(app.version)} · ${escapeHTML(app.status)}</p><small>${Number(app.downloads)||0} downloads</small></div>
        <div class="admin-actions"><button data-app-status="${app.id}" data-status="${app.status==="published"?"archived":"published"}">${app.status==="published"?"Архив":"Опубликовать"}</button><button data-app-edit="${app.id}" data-title="${escapeHTML(app.title)}" data-description="${escapeHTML(app.description||"")}" data-category="${escapeHTML(app.category||"other")}">Изменить</button><button data-app-versions="${app.id}">Версии</button><button data-app-update="${app.id}">Обновить APK</button></div></article>`).join("")||"Приложений пока нет";
      $("#adminFeedbackList").innerHTML=(feedback.feedback||[]).map(item=>`<article class="admin-feedback"><p>${escapeHTML(item.message)}</p><small>${escapeHTML(item.created_at||"")} · ${escapeHTML(item.user_id||"")}</small><button data-feedback-resolve="${item.id}">Закрыть</button></article>`).join("")||"Отзывов пока нет";
      $("#adminAnalytics").innerHTML=`<p>Пользователи: <strong>${data.users_count||0}</strong></p><p>Опубликованные приложения: <strong>${data.apps_count||0}</strong></p><p>Скачивания: <strong>${data.downloads_count||0}</strong></p><h3>Кампании</h3>${(data.ads||[]).map(ad=>`<p>${escapeHTML(ad.title)} · ${ad.impressions} показов · ${ad.clicks} кликов <button data-ad-toggle="${ad.id}" data-active="${ad.active?0:1}">${ad.active?"Выключить":"Включить"}</button><button data-ad-delete="${ad.id}">Удалить</button></p>`).join("")||"Нет кампаний"}`;
      let extra=$("#adminExtras");if(!extra){extra=document.createElement("section");extra.id="adminExtras";extra.className="admin-panel active";$("#page-admin").append(extra);}
      extra.innerHTML=`
        <div class="admin-tabs admin-extra-tabs">
          <button data-extra-tab="categories">Категории</button><button data-extra-tab="channels">Каналы</button><button data-extra-tab="ads">Реклама</button><button data-extra-tab="users">Пользователи</button><button data-extra-tab="notifications">Уведомления</button>
        </div>
        <section data-extra-panel="categories"><h3>Категории</h3><form id="categoryForm"><input name="slug" placeholder="slug" required><input name="title" placeholder="Название" required><input name="icon" placeholder="Иконка"><button>Добавить</button></form><div>${(categories.categories||[]).map(c=>`<p>${escapeHTML(c.title)} (${escapeHTML(c.slug)}) <button data-category-edit="${c.id}" data-title="${escapeHTML(c.title)}" data-icon="${escapeHTML(c.icon||"")}">Изменить</button><button data-category-delete="${c.id}">Удалить</button></p>`).join("")}</div></section>
        <section data-extra-panel="channels" hidden><h3>Обязательные каналы</h3><form id="channelForm"><input name="chat_id" placeholder="@channel или -100…" required><input name="title" placeholder="Название" required><input name="invite_url" placeholder="https://t.me/..." required><button>Добавить канал</button></form><label>Условие подписки<select id="subscriptionMode"><option value="all">На все каналы</option><option value="any">На любой канал</option></select></label><div>${(data.channels||[]).map(c=>`<p>${escapeHTML(c.title)} · ${c.enabled?"включён":"выключен"} <button data-channel-toggle="${c.id}" data-enabled="${c.enabled?0:1}">${c.enabled?"Отключить":"Включить"}</button><button data-channel-delete="${c.id}">Удалить</button></p>`).join("")}</div></section>
        <section data-extra-panel="ads" hidden><h3>Рекламная кампания</h3><form id="adForm"><input name="title" placeholder="Название кампании" required><select name="kind"><option value="banner">Баннер</option><option value="channel">Telegram-канал</option><option value="task">Задание</option></select><input name="creative_url" placeholder="URL изображения (необязательно)"><input name="target_url" placeholder="HTTPS ссылка" required><label>Начало<input name="starts_at" type="datetime-local" required></label><label>Окончание<input name="ends_at" type="datetime-local" required></label><button>Создать кампанию</button></form><p>Частота: не более 3 показов одного объявления пользователю в день.</p></section>
        <section data-extra-panel="users" hidden><h3>Пользователи</h3><div>${(users.users||[]).map(u=>`<p>${escapeHTML(u.first_name)} @${escapeHTML(u.username||"")} · ${escapeHTML(u.telegram_id)} · ${u.is_blocked?"заблокирован":"активен"} <button data-user-block="${escapeHTML(u.telegram_id)}" data-blocked="${u.is_blocked?0:1}">${u.is_blocked?"Разблокировать":"Заблокировать"}</button></p>`).join("")}</div></section>
        <section data-extra-panel="notifications" hidden><h3>Новое уведомление</h3><form id="notificationForm"><input name="title" placeholder="Заголовок" required><textarea name="message" placeholder="Сообщение" required></textarea><button>Опубликовать</button></form><h3>Опубликованные уведомления</h3>${(notifications.notifications||[]).map(n=>`<p>${escapeHTML(n.title)} · ${n.active?"активно":"скрыто"} <button data-notification-toggle="${n.id}" data-active="${n.active?0:1}">${n.active?"Скрыть":"Показать"}</button></p>`).join("")}</section>`;
      const modeSelect=$("#subscriptionMode");if(modeSelect)modeSelect.value=data.subscription_mode||"all";
      $("#adminAppsList").querySelectorAll(".admin-actions button").forEach(b=>b.classList.add("secondary-button"));
    } catch(error){toast("Не удалось загрузить панель: "+error.message);}
  }

  function adminAddAppForm() {
    if (!state.isAdmin) return;

    openModal(`
      <h2>Добавить приложение</h2>
      <form id="addAppForm">
        <label>Название<input name="title" required maxlength="100"></label>
        <label>Описание<textarea name="description" required maxlength="5000"></textarea></label>
        <label>Разработчик<input name="developer" maxlength="120"></label>
        <label>Категория<select name="category"><option value="productivity">Продуктивность</option><option value="games">Игры</option><option value="tools">Инструменты</option><option value="other">Другое</option></select></label>
        <label>Версия<input name="version" placeholder="1.0.0" required></label>
        <label>Version code<input name="version_code" type="number" min="1" required></label>
        <label>Минимальный Android<input name="min_android" placeholder="8.0"></label>
        <label>Описание обновления<textarea name="release_notes" maxlength="2000"></textarea></label>
        <label>APK-файл<input name="apk" type="file" accept=".apk,application/vnd.android.package-archive" required></label>
        <label>Иконка<input name="icon" type="file" accept="image/png,image/jpeg,image/webp"></label>
        <label>Баннер<input name="banner" type="file" accept="image/png,image/jpeg,image/webp"></label>
        <label>Скриншоты<input name="screenshots" type="file" accept="image/png,image/jpeg,image/webp" multiple></label>
        <progress id="uploadProgress" max="100" value="0" style="width:100%"></progress><p id="uploadStatus" hidden>Подготовка загрузки</p>
        <button class="primary-button full-button" type="submit">Загрузить и опубликовать</button>
      </form>
    `);
  }

  async function submitApp(form) {
    const data=new FormData(form),apk=data.get("apk"),icon=data.get("icon"),banner=data.get("banner"),screens=[...(data.getAll("screenshots")||[])].filter(x=>x instanceof File&&x.size);
    const button=form.querySelector('button[type="submit"]'); if(button)button.disabled=true;
    const status=$("#uploadStatus"); if(status)status.hidden=false;
    try {
      if(!(apk instanceof File)||!apk.size) throw new Error("Выберите APK-файл");
      const result=await uploadFileMultipart(apk,"apk",{version:data.get("version"),version_code:Number(data.get("version_code")),min_android:data.get("min_android"),release_notes:data.get("release_notes"),metadata:{title:data.get("title"),description:data.get("description"),developer:data.get("developer"),category:data.get("category")}},setUploadProgress);
      const appId=result.app_id;
      for(const [file,kind] of [[icon,"icon"],[banner,"banner"],...screens.map(file=>[file,"screenshot"])]) {
        if(file instanceof File&&file.size) await uploadFileMultipart(file,kind,{app_id:appId},setUploadProgress);
      }
      await request("/admin/apps/"+appId,{method:"PATCH",body:JSON.stringify({status:"published"})});
      closeModal();toast("Приложение загружено и опубликовано");
      await loadApps();await loadAdmin();
    } catch(error) {
      if(status)status.textContent="Ошибка: "+error.message+" · Проверьте сеть и нажмите «Повторить»";
      if(button){button.disabled=false;button.textContent="Повторить загрузку";}
      toast(error.message||"Ошибка загрузки");
    }
  }

  async function sendFeedback() {
    openModal(`
      <h2>Обратная связь</h2>
      <form id="feedbackForm">
        <label>Сообщение
          <textarea name="message" required maxlength="2000"
            placeholder="Опишите проблему или предложение..."></textarea>
        </label>
        <button class="primary-button full-button" type="submit">Отправить</button>
      </form>
    `);
  }

  async function submitFeedback(form) {
    const message = new FormData(form).get("message")?.toString().trim();
    if (!message) return;

    try {
      await request("/feedback", {
        method: "POST",
        body: JSON.stringify({ message })
      });
      closeModal();
      toast("Сообщение отправлено");
    } catch (error) {
      toast(error.message || "Не удалось отправить сообщение");
    }
  }

  const translations = {
    tj: {
      "Главная":"Асосӣ","Каталог":"Феҳрист","Избранное":"Маҳбубҳо","Профиль":"Профил",
      "Открой что-то":"Чизи навро","новое.":"кашф кун.","Лучшие приложения в одном месте.":"Барномаҳои беҳтарин дар як ҷо.",
      "Найти приложение...":"Барномаро ҷустуҷӯ кунед...","Найти":"Ҷустуҷӯ","Категории":"Категорияҳо",
      "Все":"Ҳама","Популярное":"Машҳур","Недавно добавлены":"Ба наздикӣ илова шуд",
      "Продуктивность":"Самаранокӣ","Игры":"Бозиҳо","Инструменты":"Асбобҳо","Другое":"Дигар",
      "Исследуй приложения и находи полезные инструменты.":"Барномаҳоро омӯзед ва воситаҳои муфидро пайдо кунед.",
      "Название или описание...":"Ном ё тавсиф...","Все категории":"Ҳамаи категорияҳо",
      "Сначала новые":"Аввал навҳо","Популярные":"Машҳур","По названию":"Аз рӯи ном",
      "Ничего не найдено":"Ҳеҷ чиз ёфт нашуд","Пока здесь пусто":"Ҳоло холӣ аст",
      "Открыть каталог":"Кушодани феҳрист","Язык приложения":"Забони барнома",
      "Выбери удобный язык":"Забони мувофиқро интихоб кунед","История скачиваний":"Таърихи боргириҳо",
      "Обратная связь":"Алоқа","Связаться с нами":"Бо мо тамос гиред",
      "Открыть панель управления":"Кушодани панели идоракунӣ","Уведомления":"Огоҳиномаҳо",
      "Загрузки":"Боргириҳо","Назад":"Бозгашт","Пока нет уведомлений":"Ҳоло огоҳинома нест",
      "Администрирование":"Идоракунӣ","Добавить приложение":"Иловаи барнома","Отзывы":"Шарҳҳо",
      "Статистика":"Омор","Приложения":"Барномаҳо","Пользователи":"Истифодабарандагон",
      "Скачивания":"Боргириҳо","Настройки":"Танзимот","Избранное.":"Маҳбубҳо.",
      "Подготавливаем APPNEST":"APPNEST омода шуда истодааст","Приложения, которые ты сохранил.":"Барномаҳое, ки нигоҳ доштаед.",
      "Пока здесь пусто":"Ҳоло ин ҷо холӣ аст","Добавляй приложения в избранное, чтобы быстро находить их.":"Барномаҳоро ба маҳбубҳо илова кунед, то зуд пайдо кунед.",
      "Пользователь":"Истифодабаранда","APPNEST MEMBER":"УЗВИ APPNEST","Твои последние загрузки":"Боргириҳои охирини шумо",
      "Сообщить о проблеме или предложить идею":"Дар бораи мушкилот хабар диҳед ё пешниҳод фиристед",
      "Управление каталогом и платформой.":"Идоракунии феҳрист ва платформа.","Здесь появятся приложения, которые ты скачивал.":"Барномаҳои боркардаи шумо дар ин ҷо пайдо мешаванд.",
      "Важные новости и обновления появятся здесь.":"Хабарҳо ва навсозиҳои муҳим дар ин ҷо пайдо мешаванд.",
      "Административная панель APPNEST.":"Панели идоракунии APPNEST.","Скачать приложение":"Боргирии барнома",
      "В избранное":"Ба маҳбубҳо","Убрать из избранного":"Аз маҳбубҳо хориҷ кардан","Версия:":"Версия:","Размер:":"Андоза:",
      "Что нового":"Чӣ нав аст","История версий":"Таърихи версияҳо","Подписка на каналы":"Обуна ба каналҳо",
      "Открыть канал":"Кушодани канал","Проверить снова":"Боз санҷидан","Реклама":"Реклама",
      "Добавить приложение":"Илова кардани барнома","Опубликовать":"Нашр кардан","Загрузить обновление":"Бор кардани навсозӣ",
      "Обновить APK":"Нав кардани APK","Архив":"Бойгонӣ","Изменить":"Тағйир додан","Версии":"Версияҳо",
      "Категории":"Категорияҳо","Каналы":"Каналҳо","Пользователи":"Истифодабарандагон","Уведомления":"Огоҳиномаҳо",
      "На все каналы":"Ба ҳамаи каналҳо","На любой канал":"Ба яке аз каналҳо","Добавить канал":"Илова кардани канал",
      "Новое уведомление":"Огоҳиномаи нав","Опубликованные уведомления":"Огоҳиномаҳои нашршуда",
      "Заблокировать":"Маҳкам кардан","Разблокировать":"Кушодани дастрасӣ","Выключить":"Хомӯш кардан","Включить":"Фаъол кардан",
      "Удалить":"Нест кардан","Закрыть":"Пӯшидан","Сохранить":"Нигоҳ доштан","Начало":"Оғоз","Окончание":"Анҷом"
    },
    en: {
      "Главная":"Home","Каталог":"Catalog","Избранное":"Favorites","Профиль":"Profile",
      "Открой что-то":"Discover something","новое.":"new.","Лучшие приложения в одном месте.":"The best apps in one place.",
      "Найти приложение...":"Search apps...","Найти":"Search","Категории":"Categories",
      "Все":"All","Популярное":"Popular","Недавно добавлены":"Recently added",
      "Продуктивность":"Productivity","Игры":"Games","Инструменты":"Tools","Другое":"Other",
      "Исследуй приложения и находи полезные инструменты.":"Explore apps and find useful tools.",
      "Название или описание...":"Name or description...","Все категории":"All categories",
      "Сначала новые":"Newest first","Популярные":"Popular","По названию":"By name",
      "Ничего не найдено":"Nothing found","Пока здесь пусто":"Nothing here yet",
      "Открыть каталог":"Open catalog","Язык приложения":"App language",
      "Выбери удобный язык":"Choose your preferred language","История скачиваний":"Download history",
      "Обратная связь":"Feedback","Связаться с нами":"Contact us",
      "Открыть панель управления":"Open admin panel","Уведомления":"Notifications",
      "Загрузки":"Downloads","Назад":"Back","Пока нет уведомлений":"No notifications yet",
      "Администрирование":"Administration","Добавить приложение":"Add app","Отзывы":"Feedback",
      "Статистика":"Analytics","Приложения":"Apps","Пользователи":"Users",
      "Скачивания":"Downloads","Настройки":"Settings","Избранное.":"Favorites.",
      "Подготавливаем APPNEST":"Preparing APPNEST","Приложения, которые ты сохранил.":"Apps you have saved.",
      "Добавляй приложения в избранное, чтобы быстро находить их.":"Save apps to find them quickly.",
      "Пользователь":"User","APPNEST MEMBER":"APPNEST MEMBER","Твои последние загрузки":"Your recent downloads",
      "Сообщить о проблеме или предложить идею":"Report a problem or suggest an idea",
      "Управление каталогом и платформой.":"Manage the catalog and platform.","Здесь появятся приложения, которые ты скачивал.":"Apps you download will appear here.",
      "Важные новости и обновления появятся здесь.":"Important news and updates will appear here.",
      "Административная панель APPNEST.":"APPNEST admin panel.","Скачать приложение":"Download app",
      "В избранное":"Add to favorites","Убрать из избранного":"Remove from favorites","Что нового":"What's new",
      "История версий":"Version history","Подписка на каналы":"Channel subscriptions","Открыть канал":"Open channel",
      "Проверить снова":"Check again","Реклама":"Advertisement","Добавить приложение":"Add app",
      "Опубликовать":"Publish","Загрузить обновление":"Upload update","Обновить APK":"Update APK",
      "Архив":"Archive","Изменить":"Edit","Версии":"Versions","Категории":"Categories","Каналы":"Channels",
      "Пользователи":"Users","Уведомления":"Notifications","На все каналы":"All channels","На любой канал":"Any channel",
      "Добавить канал":"Add channel","Новое уведомление":"New notification","Опубликованные уведомления":"Published notifications",
      "Заблокировать":"Block","Разблокировать":"Unblock","Выключить":"Disable","Включить":"Enable",
      "Удалить":"Delete","Закрыть":"Close","Сохранить":"Save"
    }
  };
  function applyTranslations(root=document) {
    const dict=translations[state.language]||{};
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    for(const node of nodes){if(node.__appnestOriginal===undefined)node.__appnestOriginal=node.nodeValue;const original=node.__appnestOriginal,trimmed=original.trim();if(!trimmed)continue;const translated=state.language==="ru"?original:(dict[trimmed]?original.replace(trimmed,dict[trimmed]):original);if(node.nodeValue!==translated)node.nodeValue=translated;}
    root.querySelectorAll?.("input[placeholder],textarea[placeholder]").forEach(el=>{if(!el.dataset.originalPlaceholder)el.dataset.originalPlaceholder=el.getAttribute("placeholder")||"";const original=el.dataset.originalPlaceholder;el.setAttribute("placeholder",state.language==="ru"?original:(dict[original]||original));});
  }
  function setLanguage(language) {
    if(!["ru","tj","en"].includes(language)) return;
    state.language = language;
    try { localStorage.setItem("appnest-language", language); } catch {}
    request("/me",{method:"PATCH",body:JSON.stringify({language})}).catch(error=>toast(error.message));
    document.documentElement.lang=language==="tj"?"tg":language;
    applyTranslations();
    toast(language==="ru"?"Язык изменён":language==="tj"?"Забон иваз шуд":"Language updated");
  }

  document.addEventListener("click", event => {
    const pageButton = event.target.closest("[data-page]");
    if (pageButton) {
      event.preventDefault();
      navigate(pageButton.dataset.page);
      return;
    }

    const adLink=event.target.closest("[data-ad-click]");
    if(adLink){event.preventDefault();const id=adLink.dataset.adClick;const destination=adLink.href;window.open(destination,"_blank","noopener,noreferrer");request("/ads/"+id+"/click",{method:"POST",body:JSON.stringify({})}).catch(()=>{});return;}

    const openButton = event.target.closest("[data-open-app]");
    if (openButton) {
      openDetails(openButton.dataset.openApp);
      return;
    }

    const favoriteButton = event.target.closest("[data-favorite]");
    if (favoriteButton) {
      toggleFavorite(favoriteButton.dataset.favorite);
      return;
    }

    const retryButton = event.target.closest("[data-retry-download]");
    if (retryButton) { const retryId = retryButton.dataset.retryDownload; closeModal(); downloadApp(retryId); return; }

    const downloadButton = event.target.closest("[data-download]");
    if (downloadButton) {
      downloadApp(downloadButton.dataset.download);
      return;
    }

    const categoryButton = event.target.closest("[data-category]");
    if (categoryButton) {
      state.category = categoryButton.dataset.category;
      state.pageNumber = 1;
      navigate("catalog");
      renderCatalog();
      return;
    }

    const extraTab=event.target.closest("[data-extra-tab]");
    if(extraTab){$("#adminExtras").querySelectorAll("[data-extra-panel]").forEach(p=>p.hidden=p.dataset.extraPanel!==extraTab.dataset.extraTab);return;}
    const statusButton=event.target.closest("[data-app-status]");
    if(statusButton){request("/admin/apps/"+statusButton.dataset.appStatus,{method:"PATCH",body:JSON.stringify({status:statusButton.dataset.status})}).then(loadAdmin).catch(e=>toast(e.message));return;}
    const editApp=event.target.closest("[data-app-edit]");
    if(editApp){openModal(`<h2>Редактировать приложение</h2><form id="editAppForm" data-app-id="${editApp.dataset.appEdit}"><label>Название<input name="title" value="${editApp.dataset.title}" required></label><label>Описание<textarea name="description">${editApp.dataset.description}</textarea></label><label>Категория<input name="category" value="${editApp.dataset.category}" required></label><label>Разработчик<input name="developer"></label><label>Версия<input name="version"></label><label>Минимальный Android<input name="min_android"></label><button class="primary-button full-button">Сохранить</button></form>`);return;}
    const categoryEdit=event.target.closest("[data-category-edit]");
    if(categoryEdit){const title=prompt("Название категории",categoryEdit.dataset.title);if(title)request("/admin/categories/"+categoryEdit.dataset.categoryEdit,{method:"PATCH",body:JSON.stringify({title,icon:categoryEdit.dataset.icon})}).then(loadAdmin).catch(e=>toast(e.message));return;}
    const categoryDelete=event.target.closest("[data-category-delete]");
    if(categoryDelete){if(confirm("Удалить категорию?"))request("/admin/categories/"+categoryDelete.dataset.categoryDelete,{method:"DELETE"}).then(loadAdmin).catch(e=>toast(e.message));return;}
    const channelDelete=event.target.closest("[data-channel-delete]");
    if(channelDelete){if(confirm("Удалить канал из обязательных?"))request("/admin/channels/"+channelDelete.dataset.channelDelete,{method:"DELETE"}).then(loadAdmin).catch(e=>toast(e.message));return;}
    const adDelete=event.target.closest("[data-ad-delete]");
    if(adDelete){if(confirm("Удалить рекламную кампанию?"))request("/admin/ads/"+adDelete.dataset.adDelete,{method:"DELETE"}).then(loadAdmin).catch(e=>toast(e.message));return;}
    const notificationToggle=event.target.closest("[data-notification-toggle]");
    if(notificationToggle){request("/admin/notifications/"+notificationToggle.dataset.notificationToggle,{method:"PATCH",body:JSON.stringify({active:notificationToggle.dataset.active==="1"})}).then(loadAdmin).catch(e=>toast(e.message));return;}
    const updateButton=event.target.closest("[data-app-update]");
    if(updateButton){openModal(`<h2>Обновить APK</h2><form id="updateApkForm" data-app-id="${updateButton.dataset.appUpdate}"><label>Версия<input name="version" required></label><label>Version code<input name="version_code" type="number" min="1" required></label><label>Минимальный Android<input name="min_android"></label><label>Что нового<textarea name="release_notes"></textarea></label><label>APK<input name="apk" type="file" accept=".apk,application/vnd.android.package-archive" required></label><progress id="uploadProgress" max="100" value="0" style="width:100%"></progress><p id="uploadStatus" hidden></p><button class="primary-button full-button" type="submit">Загрузить обновление</button></form>`);return;}
    const versionsButton=event.target.closest("[data-app-versions]");
    if(versionsButton){request("/admin/apps/"+versionsButton.dataset.appVersions+"/versions").then(d=>openModal("<h2>История версий</h2>"+(d.versions||[]).map(v=>"<p>v"+escapeHTML(v.version)+" · "+escapeHTML(v.created_at)+"<br>"+escapeHTML(v.release_notes||"")+"</p>").join("") )).catch(e=>toast(e.message));return;}
    const adToggle=event.target.closest("[data-ad-toggle]");
    if(adToggle){request("/admin/ads/"+adToggle.dataset.adToggle,{method:"PATCH",body:JSON.stringify({active:adToggle.dataset.active==="1"})}).then(loadAdmin).catch(e=>toast(e.message));return;}
    const channelToggle=event.target.closest("[data-channel-toggle]");
    if(channelToggle){request("/admin/channels/"+channelToggle.dataset.channelToggle,{method:"PATCH",body:JSON.stringify({enabled:channelToggle.dataset.enabled==="1"})}).then(loadAdmin).catch(e=>toast(e.message));return;}
    const userBlock=event.target.closest("[data-user-block]");
    if(userBlock){request("/admin/users/"+userBlock.dataset.userBlock,{method:"PATCH",body:JSON.stringify({blocked:userBlock.dataset.blocked==="1"})}).then(loadAdmin).catch(e=>toast(e.message));return;}
    const feedbackResolve=event.target.closest("[data-feedback-resolve]");
    if(feedbackResolve){request("/admin/feedback/"+feedbackResolve.dataset.feedbackResolve,{method:"PATCH",body:JSON.stringify({status:"resolved"})}).then(loadAdmin).catch(e=>toast(e.message));return;}
    const adminTab = event.target.closest("[data-admin-tab]");
    if (adminTab) {
      $$(".admin-tab").forEach(el => el.classList.toggle("active", el === adminTab));
      $$(".admin-panel").forEach(el => el.classList.toggle(
        "active",
        el.id === `adminPanel-${adminTab.dataset.adminTab}`
      ));
    }
  });

  $("#homeSearchForm")?.addEventListener("submit", event => {
    event.preventDefault();
    state.search = $("#homeSearch").value.trim();
    state.category = "all";
    state.pageNumber = 1;
    $("#catalogSearch").value = state.search;
    navigate("catalog");
    renderCatalog();
  });

  $("#catalogSearchForm")?.addEventListener("submit", event => {
    event.preventDefault();
    state.search = $("#catalogSearch").value.trim();
    state.pageNumber = 1;
    renderCatalog();
  });

  $("#catalogSearch")?.addEventListener("input", event => {
    state.search = event.target.value.trim();
    state.pageNumber = 1;
    renderCatalog();
  });

  $("#categoryFilter")?.addEventListener("change", event => {
    state.category = event.target.value || "all";
    state.pageNumber = 1;
    renderCatalog();
  });

  $("#sortFilter")?.addEventListener("change", event => {
    state.sort = event.target.value || "popular";
    renderCatalog();
  });

  $("#loadMoreButton")?.addEventListener("click", () => {
    state.pageNumber++;
    renderCatalog();
  });

  $("#headerAvatar")?.addEventListener("click", () => navigate("profile"));
  $("#detailsBackButton")?.addEventListener("click", () => navigate("catalog"));
  $("#notificationButton")?.addEventListener("click", () => navigate("notifications"));
  $("#modalClose")?.addEventListener("click", closeModal);

  $("#modalOverlay")?.addEventListener("click", event => {
    if (event.target.id === "modalOverlay") closeModal();
  });

  $("#feedbackButton")?.addEventListener("click", sendFeedback);
  $("#contactButton")?.addEventListener("click", () => {
    const username = "Appnest1_bot";
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(`https://t.me/${username}`);
    } else {
      window.open(`https://t.me/${username}`, "_blank");
    }
  });

  $("#historyButton")?.addEventListener("click", () => navigate("history"));
  $("#addAppButton")?.addEventListener("click", adminAddAppForm);

  document.addEventListener("change",event=>{if(event.target.id==="subscriptionMode")request("/admin/subscription-mode",{method:"PUT",body:JSON.stringify({mode:event.target.value})}).catch(e=>toast(e.message));});
  $("#languageSelect")?.addEventListener("change", event => {
    setLanguage(event.target.value);
  });

  document.addEventListener("submit", event => {
    if (event.target.id === "addAppForm") {
      event.preventDefault();
      submitApp(event.target);
    }

    const form=event.target;
    if(form.id==="editAppForm"){event.preventDefault();const d=Object.fromEntries(new FormData(form));request("/admin/apps/"+form.dataset.appId,{method:"PATCH",body:JSON.stringify(d)}).then(()=>{closeModal();loadAdmin();loadApps();}).catch(e=>toast(e.message));}
    if(form.id==="updateApkForm"){event.preventDefault();const d=new FormData(form),file=d.get("apk"),button=form.querySelector("button");button.disabled=true;const status=$("#uploadStatus");status.hidden=false;uploadFileMultipart(file,"apk",{app_id:Number(form.dataset.appId),version:d.get("version"),version_code:Number(d.get("version_code")),min_android:d.get("min_android"),release_notes:d.get("release_notes")},setUploadProgress).then(()=>{closeModal();toast("Обновление загружено");loadAdmin();loadApps();}).catch(e=>{status.textContent="Ошибка: "+e.message+" · Нажмите повторить";button.disabled=false;button.textContent="Повторить загрузку";toast(e.message);});}
    if(form.id==="categoryForm"){event.preventDefault();const d=Object.fromEntries(new FormData(form));request("/admin/categories",{method:"POST",body:JSON.stringify(d)}).then(loadAdmin).catch(e=>toast(e.message));}
    if(form.id==="channelForm"){event.preventDefault();const d=Object.fromEntries(new FormData(form));request("/admin/channels",{method:"POST",body:JSON.stringify(d)}).then(loadAdmin).catch(e=>toast(e.message));}
    if(form.id==="adForm"){event.preventDefault();const d=Object.fromEntries(new FormData(form));d.starts_at=new Date(d.starts_at).toISOString().replace("T"," ").slice(0,19);d.ends_at=new Date(d.ends_at).toISOString().replace("T"," ").slice(0,19);request("/admin/ads",{method:"POST",body:JSON.stringify(d)}).then(loadAdmin).catch(e=>toast(e.message));}
    if(form.id==="notificationForm"){event.preventDefault();const d=Object.fromEntries(new FormData(form));request("/admin/notifications",{method:"POST",body:JSON.stringify(d)}).then(loadAdmin).catch(e=>toast(e.message));}
    if (event.target.id === "feedbackForm") {
      event.preventDefault();
      submitFeedback(event.target);
    }
  });

  try {
    state.language = localStorage.getItem("appnest-language") || "ru";
    if ($("#languageSelect")) $("#languageSelect").value = state.language;
  } catch {}

  const translationObserver = new MutationObserver(records=>{for(const record of records){if(record.addedNodes.length) applyTranslations(record.target.nodeType===1?record.target:record.target.parentElement||document);}});
  translationObserver.observe(document.body,{childList:true,subtree:true});

  async function start() {
    if (!initData) {
      toast("Откройте APPNEST через Telegram");
    }
    await Promise.all([
          loadApps(),
      loadProfileData(),
      loadAds()
    ]);

    renderProfile();
    applyTranslations();
  }

  start();
})();