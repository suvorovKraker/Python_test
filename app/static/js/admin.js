const { center, zoom } = window.ADMIN_CONFIG;

let mapEngine;
let searchTimeout = null;
let mapInitialized = false;
let pendingZoneName = null;
let pendingGeojson = null;
let zonesFolder = "active";
let allZones = [];

function requireAdmin() {
  if (!getToken() || localStorage.getItem("parking_spb_role") !== "admin") {
    window.location.href = "/login";
    return false;
  }
  return true;
}

function zoneNameExists(name) {
  const normalized = name.trim().toLowerCase();
  return allZones.some((z) => z.name.trim().toLowerCase() === normalized);
}

function setupTabs() {
  document.querySelectorAll(".side-nav-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll(".side-nav-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
      if (btn.dataset.tab === "zones") await ensureMap();
      if (btn.dataset.tab === "users") loadUsers();
      if (btn.dataset.tab === "host") { await loadNetworkInfo(); await loadMapKeysInfo(); }
      if (btn.dataset.tab === "settings") await loadSettingsForm();
    });
  });
}

function setupZoneFolders() {
  document.querySelectorAll(".zones-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      zonesFolder = btn.dataset.folder;
      document.querySelectorAll(".zones-tab").forEach((b) => b.classList.toggle("active", b === btn));
      renderZonesList();
    });
  });
}

function setupDrawToolbar() {
  document.getElementById("draw-start-btn")?.addEventListener("click", () => {
    if (!mapEngine) return;
    mapEngine.enableDrawing();
    mapEngine.startDrawingMode();
  });
  document.getElementById("draw-finish-btn")?.addEventListener("click", () => {
    mapEngine?.finishDrawingMode();
  });
}

async function ensureMap() {
  if (mapInitialized) return;
  const mapKeys = await loadMapConfig();
  mapEngine = new MapEngine("map", center, zoom, mapKeys);
  await mapEngine.init();
  mapEngine.enableDrawing();
  mapEngine.onDrawCreated = () => {
    document.getElementById("draw-finish-btn")?.classList.remove("hidden");
  };
  startAutoGeolocation((pos) => {
    mapEngine.setUserMarker(pos.coords.latitude, pos.coords.longitude);
  }, () => {});
  await loadZones();
  mapInitialized = true;
}

function openNameModal(defaultName) {
  return new Promise((resolve) => {
    const modal = document.getElementById("name-modal");
    const input = document.getElementById("zone-name-input");
    if (!modal || !input) {
      resolve(defaultName.trim());
      return;
    }
    input.value = defaultName;
    modal.classList.remove("hidden");
    const ok = () => { modal.classList.add("hidden"); resolve(input.value.trim()); cleanup(); };
    const cancel = () => { modal.classList.add("hidden"); resolve(null); cleanup(); };
    const cleanup = () => {
      document.getElementById("zone-name-ok")?.removeEventListener("click", ok);
      document.getElementById("zone-name-cancel")?.removeEventListener("click", cancel);
    };
    document.getElementById("zone-name-ok")?.addEventListener("click", ok);
    document.getElementById("zone-name-cancel")?.addEventListener("click", cancel);
  });
}

function selectSearchResult(item) {
  pendingZoneName = item.short_name;
  pendingGeojson = item.geojson;
  if (item.geojson) mapEngine.setDrawnPolygon(item.geojson);
  const err = document.getElementById("zone-error");
  if (err) {
    err.classList.add("hidden");
    err.textContent = "";
  }
}

async function loadMapKeysInfo() {
  const cfg = await loadMapConfig();
  const box = document.getElementById("map-keys-box");
  if (!box) return;
  box.innerHTML = `<strong>Карты</strong><p>Яндекс: ${cfg.yandex_api_key ? "✓ подключены" : "ключ в .env"}</p>`;
}

async function loadNetworkInfo() {
  const info = await api("/api/network");
  const box = document.getElementById("network-box");
  if (box) box.innerHTML = `<a href="${info.phone_url}">${info.phone_url}</a><p class="muted">${info.note}</p>`;
}

async function loadSettingsForm() {
  const s = await api("/api/admin/settings");
  const f = document.getElementById("settings-form");
  if (!f) return;
  f.parking_timer_minutes.value = s.parking_timer_minutes;
  f.notification_interval_seconds.value = s.notification_interval_seconds;
  f.stop_detection_seconds.value = s.stop_detection_seconds;
  f.movement_radius_meters.value = s.movement_radius_meters;
}

async function loadUsers() {
  const users = await api("/api/admin/users");
  document.getElementById("users-body").innerHTML = users.map((u) => `
    <tr>
      <td>${u.id}</td>
      <td>${u.first_name || ""} ${u.last_name || ""}</td>
      <td>${u.email}</td>
      <td>${u.role}</td>
      <td><button type="button" class="pwd-btn" data-pwd="${u.password_plain || ""}">${u.password_plain ? "••••••••" : "—"}</button></td>
      <td>${new Date(u.created_at).toLocaleString("ru-RU")}</td>
      <td>${u.role === "admin" ? "" : `<button type="button" class="zone-delete-btn user-delete-btn" data-id="${u.id}" data-name="${u.first_name} ${u.last_name}">🗑</button>`}</td>
    </tr>`).join("");
  document.querySelectorAll(".pwd-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pwd = btn.dataset.pwd;
      if (!pwd) return;
      const open = btn.dataset.open === "1";
      btn.textContent = open ? "••••••••" : pwd;
      btn.dataset.open = open ? "0" : "1";
    });
  });
  document.querySelectorAll(".user-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name.trim() || "пользователя";
      if (!(await confirmAction(`Удалить аккаунт «${name}»?`))) return;
      await api(`/api/admin/users/${btn.dataset.id}`, { method: "DELETE" });
      await loadUsers();
    });
  });
}

async function loadZones() {
  allZones = await api("/api/admin/zones");
  mapEngine?.renderZones(allZones.filter((z) => z.is_active));
  renderZonesList();
}

function renderZonesList() {
  const list = document.getElementById("zones-list");
  if (!list) return;
  const filtered = allZones.filter((z) => zonesFolder === "active" ? z.is_active : !z.is_active);
  list.innerHTML = filtered.map((z) => `
    <li class="zone-card ${z.is_active ? "zone-active" : "zone-disabled"}">
      <span class="zone-name">${z.name}</span>
      <div class="zone-actions">
        <button type="button" class="secondary-btn zone-toggle" data-id="${z.id}">${z.is_active ? "Выкл" : "Вкл"}</button>
        ${!z.is_active ? `<button type="button" class="zone-delete-btn" data-id="${z.id}" title="Удалить">🗑</button>` : ""}
      </div>
    </li>`).join("") || "<li class='muted zone-card'>Пусто</li>";

  list.querySelectorAll(".zone-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const zone = allZones.find((z) => String(z.id) === btn.dataset.id);
      const msg = zone?.is_active ? `Выключить зону «${zone.name}»?` : `Включить зону «${zone.name}»?`;
      if (!(await confirmAction(msg))) return;
      await api(`/api/admin/zones/${btn.dataset.id}/toggle`, { method: "PATCH" });
      await loadZones();
    });
  });

  list.querySelectorAll(".zone-delete-btn:not(.user-delete-btn)").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const zone = allZones.find((z) => String(z.id) === btn.dataset.id);
      if (!(await confirmAction(`Удалить зону «${zone?.name}» навсегда?`))) return;
      await api(`/api/admin/zones/${btn.dataset.id}/permanent`, { method: "DELETE" });
      await loadZones();
    });
  });
}

function handleSearchResults(results, query) {
  const err = document.getElementById("zone-error");
  const resultsEl = document.getElementById("search-results");
  if (!results.length) {
    if (err) { err.textContent = "Ничего не найдено"; err.classList.remove("hidden"); }
    return;
  }

  const queryBase = query.trim().toLowerCase();
  const matchingBase = results.filter((r) => r.base_name.toLowerCase().includes(queryBase) || queryBase.includes(r.base_name.toLowerCase()));
  const duplicateGroup = matchingBase.filter((r) => r.is_duplicate_group);
  const uniqueBaseResults = matchingBase.length ? matchingBase : results;

  if (duplicateGroup.length > 1) {
    if (err) {
      err.textContent = "На карте несколько участков. Нажмите на нужный на карте или в списке.";
      err.classList.remove("hidden");
    }
    mapEngine.showPickableCandidates(duplicateGroup, (item) => {
      selectSearchResult(item);
      if (resultsEl) resultsEl.classList.add("hidden");
      if (err) err.classList.add("hidden");
    });
    if (resultsEl) {
      resultsEl.innerHTML = "";
      duplicateGroup.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item.short_name;
        li.addEventListener("click", () => {
          mapEngine.clearPickableCandidates();
          selectSearchResult(item);
          resultsEl.classList.add("hidden");
          if (err) err.classList.add("hidden");
        });
        resultsEl.appendChild(li);
      });
      resultsEl.classList.remove("hidden");
    }
    return;
  }

  const single = uniqueBaseResults[0];
  if (zoneNameExists(single.short_name)) {
    if (err) {
      err.textContent = `Зона «${single.short_name}» уже добавлена`;
      err.classList.remove("hidden");
    }
    mapEngine.clearPickableCandidates();
    return;
  }

  selectSearchResult(single);
  if (err) err.classList.add("hidden");
}

function setupStreetSearch() {
  const input = document.getElementById("street-search");
  const resultsEl = document.getElementById("search-results");
  if (!input || !resultsEl) return;
  input.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    const q = input.value.trim();
    if (q.length < 2) {
      resultsEl.classList.add("hidden");
      mapEngine?.clearPickableCandidates();
      return;
    }
    searchTimeout = setTimeout(async () => {
      const results = await api(`/api/geocode/search?q=${encodeURIComponent(q)}`);
      resultsEl.innerHTML = "";
      if (results.some((r) => r.is_duplicate_group)) {
        handleSearchResults(results, q);
        return;
      }
      results.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item.short_name;
        li.addEventListener("click", () => {
          input.value = item.short_name;
          resultsEl.classList.add("hidden");
          handleSearchResults([item], q);
        });
        resultsEl.appendChild(li);
      });
      resultsEl.classList.remove("hidden");
    }, 350);
  });
}

async function saveZone() {
  const err = document.getElementById("zone-error");
  if (!err) return;
  err.classList.add("hidden");
  mapEngine?.finishDrawingMode();

  const geojson = pendingGeojson || mapEngine?.getDrawnGeoJson();
  if (!geojson) {
    err.textContent = "Нарисуйте или выберите зону на карте.";
    err.classList.remove("hidden");
    return;
  }

  let name = pendingZoneName;
  if (!name) name = await openNameModal("");
  if (!name) return;

  if (zoneNameExists(name)) {
    err.textContent = `Зона «${name}» уже добавлена`;
    err.classList.remove("hidden");
    return;
  }

  await api("/api/admin/zones", {
    method: "POST",
    body: JSON.stringify({ name, description: null, polygon_geojson: JSON.stringify(geojson) }),
  });
  pendingZoneName = null;
  pendingGeojson = null;
  await loadZones();
  mapEngine.clearDrawnPolygon();
  mapEngine.clearPickableCandidates();
  document.getElementById("street-search").value = "";
}

async function init() {
  if (!requireAdmin()) return;
  setupTabs();
  setupZoneFolders();
  setupStreetSearch();
  setupDrawToolbar();
  document.getElementById("clear-polygon")?.addEventListener("click", () => {
    mapEngine?.clearDrawnPolygon();
    mapEngine?.clearPickableCandidates();
    pendingZoneName = null;
    pendingGeojson = null;
  });
  document.getElementById("save-zone-btn")?.addEventListener("click", saveZone);
  document.getElementById("settings-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({
        parking_timer_minutes: Number(fd.get("parking_timer_minutes")),
        notification_interval_seconds: Number(fd.get("notification_interval_seconds")),
        stop_detection_seconds: Number(fd.get("stop_detection_seconds")),
        movement_radius_meters: Number(fd.get("movement_radius_meters")),
      }),
    });
    document.getElementById("settings-ok")?.classList.remove("hidden");
  });
  document.getElementById("reset-settings-btn")?.addEventListener("click", async () => {
    await api("/api/admin/settings/reset", { method: "POST" });
    await loadSettingsForm();
  });
  await ensureMap();
  openMapTab();
}

init().catch((e) => showPageError(e.message));
