function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

// Theme is applied synchronously by an inline <script> in <head> (before first paint, so
// there's no flash of the wrong theme) -- this just wires up the toggle button to flip it.
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // storage unavailable/full -- the toggle still works for this load, it just won't stick
  }
}

function initThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  });
}

initThemeToggle();

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Not authenticated");
  }
  return res;
}

async function apiJson(url, options = {}) {
  const res = await apiFetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function initHeader() {
  let me;
  try {
    me = await apiJson("/api/auth/me");
  } catch {
    return null;
  }

  const initials = me.email.slice(0, 2).toUpperCase();
  document.getElementById("user-initials").textContent = initials;
  document.getElementById("user-email").textContent = me.email;

  if (me.role === "admin") {
    const adminLink = document.getElementById("admin-nav-link");
    if (adminLink) adminLink.style.display = "flex";
    const activityLink = document.getElementById("activity-nav-link");
    if (activityLink) activityLink.style.display = "flex";
  }

  // Each nav link is a real page (a real href), so "active" is just "does this link's
  // href match where we actually are" -- no client-side tab state to keep in sync. The one
  // exception is /lender/<slug>, a dynamic detail page with no nav link of its own -- it
  // belongs under the "Lenders" link instead of matching nothing.
  const path = window.location.pathname;
  document.querySelectorAll(".side-nav-links a").forEach((a) => {
    const href = a.getAttribute("href");
    const isActive = href === path || (href === "/lenders" && path.startsWith("/lender/"));
    a.classList.toggle("active", isActive);
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  });

  return me;
}
