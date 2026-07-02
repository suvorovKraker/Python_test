function isGeolocationSupported() {
  return "geolocation" in navigator;
}

function geolocationHint() {
  if (window.isSecureContext) return "";
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return "";
  return "На телефоне по HTTP геолокация может не работать. Разрешите доступ в настройках браузера или используйте HTTPS.";
}

function bindGeolocationButton(buttonId, onPosition, onError, statusId) {
  const btn = document.getElementById(buttonId);
  const statusEl = document.getElementById(statusId);
  if (!btn) return null;

  if (!isGeolocationSupported()) {
    if (statusEl) statusEl.textContent = "Геолокация не поддерживается в этом браузере.";
    btn.disabled = true;
    return null;
  }

  const hint = geolocationHint();
  if (hint && statusEl) statusEl.textContent = hint;

  let watchId = null;

  btn.addEventListener("click", () => {
    if (statusEl) statusEl.textContent = "Запрашиваем доступ к геолокации...";
    navigator.geolocation.getCurrentPosition(
      (position) => {
        onPosition(position);
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        watchId = navigator.geolocation.watchPosition(onPosition, onError, {
          enableHighAccuracy: true,
          maximumAge: 3000,
          timeout: 20000,
        });
        if (statusEl) statusEl.textContent = "Геолокация включена.";
        btn.textContent = "Геолокация активна";
        btn.disabled = true;
      },
      (error) => {
        const messages = {
          1: "Доступ к геолокации запрещён. Разрешите в настройках браузера.",
          2: "Не удалось определить местоположение.",
          3: "Таймаут геолокации. Попробуйте снова на улице.",
        };
        const msg = messages[error.code] || error.message;
        if (statusEl) statusEl.textContent = hint ? `${msg} ${hint}` : msg;
        onError(error);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });

  return () => {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  };
}
