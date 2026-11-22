(() => {
  "use strict";

  const API = "/api";
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
      ? `<img src="${escapeHTML(app.icon_url)}" alt="" loading="lazy">`
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
      ? `<img src="${escapeHTML(app.icon_url)}" alt="">`
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
      ${app.screenshots?.length ? `
        <div class="screenshots">
          ${app.screenshots.map(src =>
            `<img src="${escapeHTML(src)}" loading="lazy" alt="Скриншот приложения">`
          ).join("")}
        </div>` : ""}
      ${app.release_notes ? `
        <div class="release-notes">
          <h3>Что нового</h3>
          <p>${escapeHTML(app.release_notes)}</p>
        </div>` : ""}
    `;

    navigate("details");
  }

  async function downloadApp(id) {
    try {
      const result = await request(`/apps/${encodeURIComponent(id)}/download`, {
        method: "POST",
        body: JSON.stringify({})
      });

      if (!result.url) throw new Error("Ссылка на скачивание не получена");

      state.history.unshift({
        id,
        title: state.apps.find(a =>
          String(a.id ?? a.code) === String(id)
        )?.title || "Приложение",
        date: new Date().toISOString()
      });

      window.location.href = result.url;
      await loadProfileData();
    } catch (error) {
      toast(error.message || "Не удалось скачать приложение");
    }
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
      const data = await request("/admin/overview");

      $("#adminAppsCount") && ($("#adminAppsCount").textContent = data.apps_count ?? "—");
      $("#adminUsersCount") && ($("#adminUsersCount").textContent = data.users_count ?? "—");
      $("#adminDownloadsCount") && ($("#adminDownloadsCount").textContent = data.downloads_count ?? "—");

      const apps = data.apps || state.apps;
      renderList($("#adminAppsList"), apps);

      $("#adminFeedbackList") && (
        $("#adminFeedbackList").innerHTML = (data.feedback || []).map(item => `
          <article class="admin-feedback">
            <p>${escapeHTML(item.message)}</p>
            <small>${escapeHTML(item.created_at || "")}</small>
          </article>
        `).join("") || "Отзывов пока нет"
      );

      $("#adminAnalytics") && (
        $("#adminAnalytics").textContent = "Данные статистики загружены."
      );
    } catch (error) {
      toast("Не удалось загрузить панель: " + error.message);
    }
  }

  function adminAddAppForm() {
    if (!state.isAdmin) return;

    openModal(`
      <h2>Добавить приложение</h2>
      <form id="addAppForm">
        <label>Название<input name="title" required maxlength="100"></label>
        <label>Описание<textarea name="description" required maxlength="5000"></textarea></label>
        <label>Категория
          <select name="category">
            <option value="productivity">Продуктивность</option>
            <option value="games">Игры</option>
            <option value="tools">Инструменты</option>
            <option value="other">Другое</option>
          </select>
        </label>
        <label>Версия<input name="version" placeholder="1.0.0"></label>
        <label>APK-файл<input name="apk" type="file" accept=".apk,application/vnd.android.package-archive" required></label>
        <label>Иконка<input name="icon" type="file" accept="image/png,image/jpeg,image/webp"></label>
        <button class="primary-button full-button" type="submit">Опубликовать</button>
      </form>
    `);
  }

  async function submitApp(form) {
    const formData = new FormData(form);

    try {
      const response = await fetch(API + "/admin/apps", {
        method: "POST",
        headers: { "X-Telegram-Init-Data": initData },
        body: formData
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Ошибка публикации");

      closeModal();
      toast("Приложение добавлено");
      await loadApps();
      await loadAdmin();
    } catch (error) {
      toast(error.message);
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

  function setLanguage(language) {
    state.language = language;
    try {
      localStorage.setItem("appnest-language", language);
    } catch {}
    toast("Язык: " + language.toUpperCase());
  }

  document.addEventListener("click", event => {
    const pageButton = event.target.closest("[data-page]");
    if (pageButton) {
      event.preventDefault();
      navigate(pageButton.dataset.page);
      return;
    }

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

  $("#languageSelect")?.addEventListener("change", event => {
    setLanguage(event.target.value);
  });

  document.addEventListener("submit", event => {
    if (event.target.id === "addAppForm") {
      event.preventDefault();
      submitApp(event.target);
    }

    if (event.target.id === "feedbackForm") {
      event.preventDefault();
      submitFeedback(event.target);
    }
  });

  try {
    state.language = localStorage.getItem("appnest-language") || "ru";
    if ($("#languageSelect")) $("#languageSelect").value = state.language;
  } catch {}

  async function start() {
    if (!initData) {
      toast("Откройте APPNEST через Telegram");
    }
    await Promise.all([
          loadApps(),
      loadProfileData()
    ]);

    renderProfile();
  }

  start();
})();