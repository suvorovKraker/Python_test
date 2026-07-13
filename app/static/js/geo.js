function isGeolocationSupported() {
  return "geolocation" in navigator;
}

function setGeoStatus(state, detail = "") {
  const el = document.getElementById("geo-indicator");
  const retryBtn = document.getElementById("geo-retry-btn");
  if (!el) return;
  const map = {
    ok: { text: "геолокация стабильна", cls: "geo-ok", icon: "✓" },
    warn: { text: "геолокация нестабильна", cls: "geo-warn", icon: "⚠️" },
    err: { text: "геолокация не работает", cls: "geo-err", icon: "✕" },
  };
  const item = map[state] || map.err;
  el.className = `geo-indicator ${item.cls}`;
  el.textContent = `${item.icon} ${item.text}${detail ? ` — ${detail}` : ""}`;
  if (retryBtn) retryBtn.classList.toggle("hidden", state === "ok");
}

const GEO_FOREGROUND = { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 };
const GEO_BACKGROUND = { enableHighAccuracy: true, maximumAge: 8000, timeout: 15000 };
const BACKGROUND_INTERVAL_MS = 8000;

let lastPositions = [];
let geoWatchId = null;
let userOnPosition = null;
let geoOnError = null;
let geoRetryInterval = null;
let geoRetryTimeout = null;
let bgIntervalId = null;
let visibilityBound = false;
let firstFixReceived = false;

function trackGeoQuality(lat, lng) {
  const now = Date.now();
  lastPositions.push({ lat, lng, ts: now });
  lastPositions = lastPositions.filter((p) => now - p.ts < 20000);
  if (lastPositions.length < 2) {
    setGeoStatus("warn");
    return;
  }
  const recent = lastPositions.slice(-5);
  const spread = Math.max(...recent.map((p) => Math.abs(p.lat - lat) + Math.abs(p.lng - lng)));
  if (spread > 0.0003) setGeoStatus("warn", "сигнал прыгает");
  else setGeoStatus("ok");
}

function stopGeolocation() {
  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
}

function stopBackgroundGeolocation() {
  if (bgIntervalId !== null) {
    clearInterval(bgIntervalId);
    bgIntervalId = null;
  }
}

function clearGeoRetryTimers() {
  if (geoRetryInterval) { clearInterval(geoRetryInterval); geoRetryInterval = null; }
  if (geoRetryTimeout) { clearTimeout(geoRetryTimeout); geoRetryTimeout = null; }
}

function handlePosition(position) {
  trackGeoQuality(position.coords.latitude, position.coords.longitude);
  if (userOnPosition) userOnPosition(position);
  setGeoStatus("ok");
}

function startForegroundGeolocation(onFail) {
  stopBackgroundGeolocation();
  stopGeolocation();
  navigator.geolocation.getCurrentPosition(handlePosition, onFail, GEO_FOREGROUND);
  geoWatchId = navigator.geolocation.watchPosition(handlePosition, onFail, GEO_FOREGROUND);
}

function startBackgroundGeolocation(onFail) {
  stopGeolocation();
  const tick = () => navigator.geolocation.getCurrentPosition(handlePosition, onFail, GEO_BACKGROUND);
  tick();
  bgIntervalId = setInterval(tick, BACKGROUND_INTERVAL_MS);
  setGeoStatus("warn", "фоновый режим ~8 с");
}

function bindVisibilityHandling() {
  if (visibilityBound) return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (!userOnPosition) return;
    const onFail = geoOnError || (() => {});
    if (document.hidden) startBackgroundGeolocation(onFail);
    else startForegroundGeolocation(onFail);
  });
}

function startAutoGeolocation(onPosition, onError, options = {}) {
  userOnPosition = onPosition;
  geoOnError = onError || (() => {});
  const withCountdown = !!options.withCountdown;

  if (!isGeolocationSupported()) {
    setGeoStatus("err", "не поддерживается");
    return null;
  }

  bindVisibilityHandling();
  if (!withCountdown) setGeoStatus("warn", "определяем...");
  lastPositions = [];
  firstFixReceived = false;

  const retryBtn = document.getElementById("geo-retry-btn");
  if (retryBtn) retryBtn.disabled = withCountdown;

  const onFail = (error) => {
    if (!firstFixReceived) {
      setGeoStatus("err", error.message);
      geoOnError(error);
    }
  };

  const onPositionUpdate = (position) => {
    if (!firstFixReceived) {
      firstFixReceived = true;
      clearGeoRetryTimers();
      if (retryBtn) retryBtn.disabled = false;
    }
    handlePosition(position);
  };

  const wrappedFail = onFail;
  const wrappedPosition = onPositionUpdate;

  if (document.hidden) {
    stopBackgroundGeolocation();
    const tick = () => navigator.geolocation.getCurrentPosition(wrappedPosition, wrappedFail, GEO_BACKGROUND);
    tick();
    bgIntervalId = setInterval(tick, BACKGROUND_INTERVAL_MS);
    setGeoStatus("warn", "фоновый режим ~8 с");
  } else {
    stopGeolocation();
    stopBackgroundGeolocation();
    navigator.geolocation.getCurrentPosition(wrappedPosition, wrappedFail, GEO_FOREGROUND);
    geoWatchId = navigator.geolocation.watchPosition(wrappedPosition, wrappedFail, GEO_FOREGROUND);
  }

  if (withCountdown) {
    let secondsLeft = 10;
    setGeoStatus("warn", `подключение… ${secondsLeft} с`);
    geoRetryInterval = setInterval(() => {
      secondsLeft -= 1;
      if (firstFixReceived) { clearGeoRetryTimers(); return; }
      if (secondsLeft > 0) setGeoStatus("warn", `подключение… ${secondsLeft} с`);
    }, 1000);
    geoRetryTimeout = setTimeout(() => {
      clearGeoRetryTimers();
      if (!firstFixReceived) {
        stopGeolocation();
        stopBackgroundGeolocation();
        setGeoStatus("err", "не удалось за 10 с");
        if (retryBtn) { retryBtn.disabled = false; retryBtn.classList.remove("hidden"); }
      }
    }, 10000);
  }

  return geoWatchId;
}

function retryGeolocation() {
  if (userOnPosition) startAutoGeolocation(userOnPosition, geoOnError, { withCountdown: true });
}

function setupGeoRetry() {
  document.getElementById("geo-retry-btn")?.addEventListener("click", retryGeolocation);
}

function setupCollapsibleNav(navId) {
  const nav = document.getElementById(navId);
  if (!nav) return;
  const toggle = nav.querySelector(".side-nav-toggle");
  toggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    nav.classList.toggle("expanded");
  });
}

function confirmAction(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const msg = document.getElementById("confirm-message");
    const yes = document.getElementById("confirm-yes");
    const no = document.getElementById("confirm-no");
    if (!modal || !msg || !yes || !no) {
      resolve(window.confirm(message));
      return;
    }
    msg.textContent = message;
    modal.classList.remove("hidden");
    const cleanup = () => {
      modal.classList.add("hidden");
      yes.removeEventListener("click", onYes);
      no.removeEventListener("click", onNo);
    };
    const onYes = () => { cleanup(); resolve(true); };
    const onNo = () => { cleanup(); resolve(false); };
    yes.addEventListener("click", onYes);
    no.addEventListener("click", onNo);
  });
}

function openMapTab() {
  const btn = document.querySelector('.side-nav-btn[data-tab="map"], .side-nav-btn[data-tab="zones"]');
  btn?.click();
}

function setupBrandLink() {
  document.getElementById("brand-link")?.addEventListener("click", (e) => {
    const path = window.location.pathname;
    if (path === "/" || path === "/admin") {
      e.preventDefault();
      openMapTab();
      if (path === "/admin" && typeof ensureMap === "function") ensureMap();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupGeoRetry();
  setupBrandLink();
});
