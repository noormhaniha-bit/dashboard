const CMDK_PAGE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;
const CMDK_LENDER_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M4 21V10l8-6 8 6v11"/><path d="M9 21v-6h6v6"/></svg>`;
const CMDK_ACTION_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`;

const CMDK_PAGES = [
  { label: "Overview", href: "/overview" },
  { label: "Reports", href: "/" },
  { label: "Analytics", href: "/analytics" },
  { label: "Lenders", href: "/lenders" },
  { label: "FullStory", href: "/fullstory" },
  { label: "Admin", href: "/admin", adminOnly: true },
  { label: "Activity", href: "/activity", adminOnly: true },
  { label: "Security", href: "/security" },
];

let cmdkLenders = null; // lazily fetched once, cached for the rest of the session
let cmdkIsAdmin = false;
let cmdkOverlay = null;
let cmdkActiveIndex = 0;
let cmdkResults = [];

function cmdkLooksLikeId(text) {
  return /^[a-z0-9-]{10,}$/i.test(text.trim());
}

async function cmdkEnsureLenders() {
  if (cmdkLenders !== null) return cmdkLenders;
  try {
    cmdkLenders = await apiJson("/api/lenders");
  } catch {
    cmdkLenders = [];
  }
  return cmdkLenders;
}

function cmdkUpdateActive() {
  const items = cmdkOverlay.querySelectorAll(".cmdk-item");
  items.forEach((el, i) => el.classList.toggle("active", i === cmdkActiveIndex));
  const activeEl = items[cmdkActiveIndex];
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

function cmdkRunAction(item) {
  if (!item) return;
  cmdkClose();
  window.location.href = item.href;
}

async function cmdkRender(query) {
  const q = query.trim().toLowerCase();
  const resultsEl = cmdkOverlay.querySelector(".cmdk-results");
  const results = [];

  for (const p of CMDK_PAGES) {
    if (p.adminOnly && !cmdkIsAdmin) continue;
    if (q && !p.label.toLowerCase().includes(q)) continue;
    results.push({ label: p.label, href: p.href, icon: CMDK_PAGE_ICON });
  }

  if (q) {
    const lenders = await cmdkEnsureLenders();
    for (const l of lenders.filter((l) => l.name.toLowerCase().includes(q)).slice(0, 6)) {
      results.push({ label: `${l.name} (lender)`, href: `/lender/${encodeURIComponent(l.slug)}`, icon: CMDK_LENDER_ICON });
    }
  }

  if (q && cmdkLooksLikeId(q)) {
    const raw = query.trim();
    results.push({
      label: `Look up application "${raw}" in Analytics`,
      href: `/analytics?query=application_lookup&application_id=${encodeURIComponent(raw)}`,
      icon: CMDK_ACTION_ICON,
    });
    results.push({ label: `View FullStory job "${raw}"`, href: `/fullstory?job=${encodeURIComponent(raw)}`, icon: CMDK_ACTION_ICON });
  }

  // A stale response for an older query could otherwise land after a newer one -- the lender
  // fetch above is async, so re-check the input still matches what we rendered for.
  const input = cmdkOverlay?.querySelector(".cmdk-input");
  if (!input || input.value.trim().toLowerCase() !== q) return;

  cmdkResults = results;
  cmdkActiveIndex = 0;

  if (results.length === 0) {
    resultsEl.innerHTML = `<div class="cmdk-empty">No matches.</div>`;
    return;
  }

  resultsEl.innerHTML = results
    .map((r, i) => `<div class="cmdk-item${i === 0 ? " active" : ""}" data-index="${i}">${r.icon}<span>${escapeHtml(r.label)}</span></div>`)
    .join("");
  resultsEl.querySelectorAll(".cmdk-item").forEach((el) => {
    el.addEventListener("click", () => cmdkRunAction(cmdkResults[Number(el.dataset.index)]));
    el.addEventListener("mouseenter", () => {
      cmdkActiveIndex = Number(el.dataset.index);
      cmdkUpdateActive();
    });
  });
}

function cmdkHandleKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    cmdkClose();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    cmdkActiveIndex = Math.min(cmdkActiveIndex + 1, cmdkResults.length - 1);
    cmdkUpdateActive();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    cmdkActiveIndex = Math.max(cmdkActiveIndex - 1, 0);
    cmdkUpdateActive();
  } else if (e.key === "Enter") {
    e.preventDefault();
    cmdkRunAction(cmdkResults[cmdkActiveIndex]);
  }
}

function cmdkOpen() {
  if (cmdkOverlay) return;
  cmdkOverlay = document.createElement("div");
  cmdkOverlay.className = "cmdk-overlay";
  cmdkOverlay.innerHTML = `
    <div class="cmdk-modal">
      <div class="cmdk-input-row">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input class="cmdk-input" type="text" placeholder="Search pages, lenders, or paste an ID…" autocomplete="off" />
      </div>
      <div class="cmdk-results"></div>
    </div>`;
  cmdkOverlay.addEventListener("click", (e) => {
    if (e.target === cmdkOverlay) cmdkClose();
  });
  document.body.appendChild(cmdkOverlay);

  const input = cmdkOverlay.querySelector(".cmdk-input");
  input.addEventListener("input", () => cmdkRender(input.value));
  input.addEventListener("keydown", cmdkHandleKeydown);
  cmdkRender("");
  input.focus();
}

function cmdkClose() {
  if (cmdkOverlay) {
    cmdkOverlay.remove();
    cmdkOverlay = null;
  }
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (cmdkOverlay) cmdkClose();
    else cmdkOpen();
  }
});

async function initCommandPalette() {
  try {
    const me = await apiJson("/api/auth/me");
    cmdkIsAdmin = me.role === "admin";
  } catch {
    cmdkIsAdmin = false;
  }
  const btn = document.getElementById("cmdk-trigger");
  if (btn) btn.addEventListener("click", cmdkOpen);
}

initCommandPalette();
