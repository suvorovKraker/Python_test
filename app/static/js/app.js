const { center, zoom } = window.APP_CONFIG;

let mapEngine;
let appSettings = {
  stop_detection_seconds: 120,
  movement_radius_meters: 30,
  parking_timer_minutes: 15,
};
let activeSession = null;
let positions = [];
let stationarySince = null;
let trackingEnabled = false;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateAuthUi() {
  const token = getToken();
  const role = localStorage.getItem("parking_spb_role");
  document.getElementById("login-link").classList.toggle("hidden", !!token);
  document.getElementById("logout-btn").classList.toggle("hidden", !token);
  document.getElementById("admin-link").classList.toggle("hidden", role !== "admin");
}

function updatePaidButton() {
  document.getElementById("paid-btn").classList.toggle("hidden", !activeSession || !getToken());
}

function updateTimerDisplay() {
  const el = document.getElementById("timer-status");
  if (!activeSession || !getToken()) {
    el.classList.add("hidden");
    return;
  }
  const leftMs = new Date(activeSession.expires_at).getTime() - Date.now();
  el.textContent = leftMs <= 0
    ? "Время истекло"
    : `Осталось: ${Math.floor(leftMs / 60000)}:${String(Math.floor((leftMs % 60000) / 1000)).padStart(2, "0")}`;
  el.classList.remove("hidden");
}

async function loadSettings() {
  appSettings = await api("/api/settings");
}

async function refreshSession() {
  if (!getToken()) return;
  activeSession = await api("/api/tracking/session");
  updatePaidButton();
  updateTimerDisplay();
}

async function loadZones() {
  const zones = await api("/api/zones");
  mapEngine.renderZones(zones);
}

function showBrowserNotification(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

async function pollNotifications() {
  if (!getToken()) return;
  try {
    const items = await api("/api/notifications");
    const panel = document.getElementById("notifications-panel");
    panel.innerHTML = items.length ? "<h3>Уведомления</h3>" : "";
    for (const item of items) {
      const div = document.createElement("div");
      div.className = `notification-item ${item.type}`;
      div.innerHTML = `<strong>${item.title}</strong><p>${item.message}</p>`;
      panel.appendChild(div);
      showBrowserNotification(item.title, item.message);
      await api(`/api/notifications/${item.id}/read`, { method: "POST" });
    }
    await refreshSession();
  } catch (_) {}
}

function isStationary(lat, lng) {
  const stopSeconds = appSettings.stop_detection_seconds;
  const movementRadius = appSettings.movement_radius_meters;
  const now = Date.now();
  positions.push({ lat, lng, ts: now });
  positions = positions.filter((p) => now - p.ts <= stopSeconds * 1000);
  if (positions.length < 2) {
    stationarySince = null;
    return false;
  }
  const maxDistance = Math.max(...positions.map((p) => haversineMeters(lat, lng, p.lat, p.lng)));
  if (maxDistance > movementRadius) {
    stationarySince = null;
    return false;
  }
  if (!stationarySince) stationarySince = positions[0].ts;
  return now - stationarySince >= stopSeconds * 1000;
}

async function sendTracking(lat, lng, is_stationary) {
  const result = await api("/api/tracking/update", {
    method: "POST",
    body: JSON.stringify({ lat, lng, is_stationary }),
  });
  if (result.session_id) {
    activeSession = { id: result.session_id, expires_at: result.expires_at, zone: result.zone };
  } else if (result.action === "session_cancelled") {
    activeSession = null;
  }
  updatePaidButton();
  updateTimerDisplay();
  const statusEl = document.getElementById("session-status");
  statusEl.textContent = result.zone
    ? `Зона: ${result.zone.name}. ${result.message || result.action}`
    : result.message || result.action;
}

function onPosition(position) {
  const { latitude: lat, longitude: lng } = position.coords;
  mapEngine.setUserMarker(lat, lng);

  if (!getToken()) {
    document.getElementById("session-status").textContent = "Войдите, чтобы отслеживать парковку.";
    return;
  }

  if (!trackingEnabled) return;

  const stationary = isStationary(lat, lng);
  document.getElementById("geo-status").textContent = stationary
    ? "Стоите на месте — проверяем зону..."
    : `Движение — таймер после ${Math.round(appSettings.stop_detection_seconds / 60)} мин на месте`;

  sendTracking(lat, lng, stationary).catch((error) => {
    document.getElementById("session-status").textContent = error.message;
  });
}

async function init() {
  updateAuthUi();
  const mapKeys = await loadMapConfig();
  mapEngine = new MapEngine("map", center, zoom, mapKeys);
  const control = addProviderControl(mapEngine, "map-provider");
  await mapEngine.init(control.initial);

  bindGeolocationButton("geo-btn", onPosition, () => {}, "geo-status");

  document.getElementById("logout-btn").addEventListener("click", () => {
    clearAuth();
    window.location.reload();
  });

  document.getElementById("paid-btn").addEventListener("click", async () => {
    await api("/api/tracking/paid", { method: "POST" });
    activeSession = null;
    updatePaidButton();
    updateTimerDisplay();
    document.getElementById("session-status").textContent = "Парковка отмечена как оплаченная.";
    pollNotifications();
  });

  await loadSettings();
  await loadZones();

  if (getToken()) {
    trackingEnabled = true;
    await refreshSession();
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    setInterval(updateTimerDisplay, 1000);
    setInterval(pollNotifications, 10000);
    pollNotifications();
    document.getElementById("geo-status").textContent =
      "Нажмите «Включить геолокацию», чтобы видеть себя на карте.";
  } else {
    document.getElementById("geo-status").textContent =
      "Войдите в аккаунт для таймера. Геолокацию можно включить без входа.";
  }
}

init().catch((error) => showPageError(error.message));
