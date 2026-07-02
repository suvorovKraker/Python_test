const { center, zoom } = window.ADMIN_CONFIG;

let mapEngine;
let searchTimeout = null;
let mapInitialized = false;

function requireAdmin() {
  const token = getToken();
  const role = localStorage.getItem("parking_spb_role");
  if (!token || role !== "admin") {
    window.location.href = "/login";
    return false;
  }
  return true;
}

function setupTabs() {
  const buttons = document.querySelectorAll(".admin-tab-btn");
  const panels = document.querySelectorAll(".admin-tab-panel");

  buttons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tab = btn.dataset.tab;
      buttons.forEach((b) => b.classList.toggle("active", b === btn));
      panels.forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));

      if (tab === "zones") {
        await ensureMap();
        if (mapEngine?.map && mapEngine.engine === "leaflet") {
          setTimeout(() => mapEngine.map.invalidateSize(), 100);
        }
      }
      if (tab === "users") loadUsers();
      if (tab === "host") {
        await loadNetworkInfo();
        await loadMapKeysInfo();
      }
      if (tab === "settings") await loadSettingsForm();
    });
  });
}

async function ensureMap() {
  if (mapInitialized) return;
  const mapKeys = await loadMapConfig();
  mapEngine = new MapEngine("map", center, zoom, mapKeys);
  const control = addProviderControl(mapEngine, "map-provider", (providerId) => {
    updateDrawHint(providerId);
    if (mapEngine.supportsDrawing(providerId)) mapEngine.enableDrawing();
  });
  await mapEngine.init(control.initial);
  if (mapEngine.supportsDrawing(control.initial)) mapEngine.enableDrawing();
  updateDrawHint(control.initial);
  await loadZones();
  mapInitialized = true;

  bindGeolocationButton(
    "geo-btn",
    (position) => {
      const { latitude: lat, longitude: lng } = position.coords;
      mapEngine.setUserMarker(lat, lng);
    },
    () => {},
    "geo-status"
  );
}

function updateDrawHint(providerId) {
  const hint = document.getElementById("draw-hint");
  if (!hint || !mapEngine) return;
  hint.classList.toggle("hidden", mapEngine.supportsDrawing(providerId));
}

async function loadMapKeysInfo() {
  const cfg = await loadMapConfig();
  const box = document.getElementById("map-keys-box");
  if (!box) return;
  const yandexOk = !!cfg.yandex_api_key;
  const dgisOk = !!cfg.dgis_api_key;
  box.innerHTML = `
    <strong>Карты:</strong>
    <p>Яндекс — ${yandexOk ? "подключён" : `не настроен (<a href="${cfg.yandex_docs}" target="_blank">получить ключ</a>)`}</p>
    <p>2ГИС — ${dgisOk ? "подключён" : `не настроен (<a href="${cfg.dgis_docs}" target="_blank">получить ключ</a>)`}</p>
    <p class="muted">Ключи в .env: YANDEX_MAPS_API_KEY и DGIS_API_KEY (нужна регистрация на ваше имя)</p>
  `;
}

async function loadNetworkInfo() {
  const info = await api("/api/network");
  const box = document.getElementById("network-box");
  if (!box) return;
  box.innerHTML = `
    <strong>Адрес для телефона:</strong>
    <a href="${info.phone_url}">${info.phone_url}</a>
    <p class="muted">${info.note}</p>
    <p class="muted">VPN на Mac отключите. Телефон и Mac — одна Wi‑Fi сеть.</p>
  `;
}

async function loadSettingsForm() {
  const settings = await api("/api/admin/settings");
  const form = document.getElementById("settings-form");
  form.parking_timer_minutes.value = settings.parking_timer_minutes;
  form.notification_interval_minutes.value = settings.notification_interval_minutes;
  form.stop_detection_seconds.value = settings.stop_detection_seconds;
  form.movement_radius_meters.value = settings.movement_radius_meters;
}

async function loadUsers() {
  const users = await api("/api/admin/users");
  const body = document.getElementById("users-body");
  body.innerHTML = users.map((u) => `
    <tr>
      <td>${u.id}</td>
      <td>${u.email}</td>
      <td>${u.role}</td>
      <td>${u.is_active ? "да" : "нет"}</td>
      <td>${new Date(u.created_at).toLocaleString("ru-RU")}</td>
    </tr>
  `).join("");
}

async function loadZones() {
  if (!mapEngine) return;
  const zones = await api("/api/zones");
  mapEngine.renderZones(zones);
  const list = document.getElementById("zones-list");
  list.innerHTML = "";
  zones.forEach((zone) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${zone.name}</span>`;
    const btn = document.createElement("button");
    btn.textContent = "Скрыть";
    btn.className = "secondary-btn";
    btn.addEventListener("click", async () => {
      await api(`/api/admin/zones/${zone.id}`, { method: "DELETE" });
      window.location.reload();
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function setupStreetSearch() {
  const input = document.getElementById("street-search");
  const resultsEl = document.getElementById("search-results");
  input.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    const q = input.value.trim();
    if (q.length < 2) {
      resultsEl.classList.add("hidden");
      resultsEl.innerHTML = "";
      return;
    }
    searchTimeout = setTimeout(async () => {
      try {
        const results = await api(`/api/geocode/search?q=${encodeURIComponent(q)}`);
        resultsEl.innerHTML = "";
        results.forEach((item) => {
          const li = document.createElement("li");
          li.textContent = item.display_name;
          li.addEventListener("click", () => {
            input.value = item.display_name;
            resultsEl.classList.add("hidden");
            const nameInput = document.querySelector('#zone-form [name="name"]');
            if (!nameInput.value) nameInput.value = item.display_name.split(",")[0];
            if (item.geojson && mapEngine.supportsDrawing(localStorage.getItem("parking_map_provider") || "osm")) {
              mapEngine.setDrawnPolygon(item.geojson);
            } else if (item.geojson) {
              mapEngine.fitGeoJson(item.geojson);
            } else {
              mapEngine.setView(item.lat, item.lng, 17);
            }
          });
          resultsEl.appendChild(li);
        });
        resultsEl.classList.remove("hidden");
      } catch (error) {
        resultsEl.innerHTML = `<li class='error'>${error.message}</li>`;
        resultsEl.classList.remove("hidden");
      }
    }, 400);
  });
}

async function init() {
  if (!requireAdmin()) return;
  setupTabs();
  setupStreetSearch();

  document.getElementById("clear-polygon").addEventListener("click", () => {
    mapEngine?.clearDrawnPolygon();
  });

  document.getElementById("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("settings-error");
    const okEl = document.getElementById("settings-ok");
    errorEl.classList.add("hidden");
    okEl.classList.add("hidden");
    const formData = new FormData(event.target);
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({
          parking_timer_minutes: Number(formData.get("parking_timer_minutes")),
          notification_interval_minutes: Number(formData.get("notification_interval_minutes")),
          stop_detection_seconds: Number(formData.get("stop_detection_seconds")),
          movement_radius_meters: Number(formData.get("movement_radius_meters")),
        }),
      });
      okEl.classList.remove("hidden");
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
    }
  });

  document.getElementById("zone-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("zone-error");
    errorEl.classList.add("hidden");
    const geojson = mapEngine?.getDrawnGeoJson();
    if (!geojson) {
      errorEl.textContent = "Сначала нарисуйте полигон (OSM/Carto).";
      errorEl.classList.remove("hidden");
      return;
    }
    const formData = new FormData(event.target);
    try {
      await api("/api/admin/zones", {
        method: "POST",
        body: JSON.stringify({
          name: formData.get("name"),
          description: formData.get("description") || null,
          polygon_geojson: JSON.stringify(geojson),
        }),
      });
      window.location.reload();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
    }
  });

  await ensureMap();
}

init().catch((error) => showPageError(error.message));
