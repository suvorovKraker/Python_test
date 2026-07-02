const { center, zoom } = window.APP_CONFIG || {};

function toggleHidden(id, hidden) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle("hidden", hidden);
}

let mapEngine;
let appSettings = {};
let activeSession = null;
let positions = [];
let stationarySince = null;
let suppressUntilMove = false;
let lastLat = null;
let lastLng = null;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const t = (v) => (v * Math.PI) / 180;
  const a = Math.sin((t(lat2 - lat1)) / 2) ** 2 + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin((t(lng2 - lng1)) / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function setupUserTabs() {
  document.querySelectorAll("#user-nav .side-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#user-nav .side-nav-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
      if (btn.dataset.tab === "map" && mapEngine?.map?.container?.fitToViewport) {
        setTimeout(() => mapEngine.map.container.fitToViewport(), 100);
      }
    });
  });
}

function updateSessionUi() {
  const has = !!activeSession && getToken();
  toggleHidden("paid-btn", !has);
  toggleHidden("left-btn", !has);
  toggleHidden("timer-big", !has);
}

function updateTimerBig() {
  const el = document.getElementById("timer-big");
  if (!activeSession || !el) return;
  const left = new Date(activeSession.expires_at).getTime() - Date.now();
  if (left <= 0) { el.textContent = "00:00"; return; }
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  el.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function isStationary(lat, lng) {
  const stop = appSettings.stop_detection_seconds;
  const rad = appSettings.movement_radius_meters;
  const now = Date.now();
  positions.push({ lat, lng, ts: now });
  positions = positions.filter((p) => now - p.ts <= stop * 1000);
  if (positions.length < 2) { stationarySince = null; return false; }
  const maxD = Math.max(...positions.map((p) => haversineMeters(lat, lng, p.lat, p.lng)));
  if (maxD > rad) { stationarySince = null; return false; }
  if (!stationarySince) stationarySince = positions[0].ts;
  return now - stationarySince >= stop * 1000;
}

async function sendTracking(lat, lng, stationary) {
  if (!getToken() || suppressUntilMove) return;
  const r = await api("/api/tracking/update", {
    method: "POST",
    body: JSON.stringify({ lat, lng, is_stationary: stationary }),
  });
  if (r.session_id) activeSession = { id: r.session_id, expires_at: r.expires_at, zone: r.zone };
  else if (["session_cancelled", "moving"].includes(r.action)) activeSession = null;
  updateSessionUi();
  const status = document.getElementById("session-status");
  if (r.zone && status) status.textContent = `Зона: ${r.zone.name}`;
  else if (r.action === "session_started" && status) status.textContent = `Таймер запущен: ${r.zone?.name || ""}`;
}

function onPosition(position) {
  const { latitude: lat, longitude: lng, accuracy } = position.coords;

  if (lastLat !== null && haversineMeters(lastLat, lastLng, lat, lng) > appSettings.movement_radius_meters) {
    suppressUntilMove = false;
    positions = [];
    stationarySince = null;
  }
  lastLat = lat;
  lastLng = lng;

  mapEngine.setUserMarker(lat, lng);

  if (!getToken()) return;

  const stationary = isStationary(lat, lng);
  if (accuracy > 80) setGeoStatus("warn", `±${Math.round(accuracy)} м`);
  sendTracking(lat, lng, stationary);
}

async function pollNotifications() {
  if (!getToken()) return;
  try {
    const items = await api("/api/notifications");
    const panel = document.getElementById("notifications-panel");
    if (!panel) return;
    panel.innerHTML = items.length ? "<h3>🔔 Уведомления</h3>" : "";
    for (const item of items) {
      const div = document.createElement("div");
      div.className = `notification-item ${item.type}`;
      div.innerHTML = `<strong>${item.title}</strong><p>${item.message}</p>`;
      panel.appendChild(div);
      await api(`/api/notifications/${item.id}/read`, { method: "POST" });
    }
    if (getToken()) {
      activeSession = await api("/api/tracking/session");
      updateSessionUi();
    }
  } catch (_) {}
}

async function init() {
  if (!document.getElementById("map")) return;

  setupUserTabs();
  openMapTab();
  const token = getToken();
  toggleHidden("login-link", !!token);
  toggleHidden("logout-btn", !token);
  toggleHidden("admin-link", localStorage.getItem("parking_spb_role") !== "admin");

  const mapKeys = await loadMapConfig();
  mapEngine = new MapEngine("map", center, zoom, mapKeys);
  await mapEngine.init();
  appSettings = await api("/api/settings");
  await loadZones();

  startAutoGeolocation(onPosition, () => {});

  document.getElementById("logout-btn")?.addEventListener("click", () => { clearAuth(); location.reload(); });
  document.getElementById("paid-btn")?.addEventListener("click", async () => {
    await api("/api/tracking/paid", { method: "POST" });
    activeSession = null;
    updateSessionUi();
    pollNotifications();
  });
  document.getElementById("left-btn")?.addEventListener("click", async () => {
    await api("/api/tracking/left", { method: "POST" });
    activeSession = null;
    suppressUntilMove = true;
    updateSessionUi();
    const status = document.getElementById("session-status");
    if (status) status.textContent = "Таймер остановлен до следующей остановки.";
  });

  if (token) {
    const userEmail = document.getElementById("user-email");
    if (userEmail) userEmail.textContent = "Вы вошли в систему";
    activeSession = await api("/api/tracking/session");
    updateSessionUi();
    setInterval(updateTimerBig, 1000);
    setInterval(pollNotifications, 10000);
    pollNotifications();
    if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  }
}

async function loadZones() {
  const zones = await api("/api/zones");
  mapEngine.renderZones(zones);
}

init().catch((e) => showPageError(e.message));
