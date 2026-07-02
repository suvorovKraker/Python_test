const TOKEN_KEY = "parking_spb_token";
const ROLE_KEY = "parking_spb_role";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setAuth(token, role) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ROLE_KEY, role);
}

function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || "Ошибка запроса");
  }
  return response.json();
}

function setupAuthForm(mode) {
  const form = document.getElementById(mode === "login" ? "login-form" : "register-form");
  const errorEl = document.getElementById("error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.classList.add("hidden");
    const formData = new FormData(form);
    const payload = {
      email: formData.get("email"),
      password: formData.get("password"),
    };
    try {
      const data = await api(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setAuth(data.access_token, data.role);
      window.location.href = data.role === "admin" ? "/admin" : "/";
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
    }
  });
}
