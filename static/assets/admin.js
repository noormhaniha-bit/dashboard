let adminOptions = null; // { pdf_lenders: [...names], lenders: [...] }
let selectedUserId = null;
let allUsers = [];
let usersSortable = null;

const USER_SORT_COMPARATORS = {
  email: (a, b) => a.email.localeCompare(b.email),
  role: (a, b) => a.role.localeCompare(b.role),
  status: (a, b) => Number(a.is_active) - Number(b.is_active),
  totp: (a, b) => Number(a.totp_enabled) - Number(b.totp_enabled),
};

function userRow(u) {
  const statusPill = u.is_active ? "" : `<span class="pill inactive">Inactive</span>`;
  const totpPill = u.totp_enabled ? `<span class="pill on">On</span>` : `<span class="pill off">Off</span>`;
  const safeEmail = escapeHtml(u.email);
  const safeRole = escapeHtml(u.role);
  return `<tr>
      <td>${safeEmail}</td>
      <td><span class="pill ${safeRole}">${safeRole}</span></td>
      <td>${statusPill || "Active"}</td>
      <td>${totpPill}</td>
      <td class="row-actions">
        <button class="secondary" data-action="access" data-id="${u.id}" data-email="${safeEmail}">Manage access</button>
        <button class="danger-text" data-action="toggle" data-id="${u.id}" data-active="${u.is_active}">
          ${u.is_active ? "Deactivate" : "Activate"}
        </button>
        ${u.totp_enabled ? `<button class="danger-text" data-action="reset-2fa" data-id="${u.id}" data-email="${safeEmail}">Reset 2FA</button>` : ""}
      </td>
    </tr>`;
}

function renderAdminStats(users) {
  const statRow = document.getElementById("admin-stats");
  const admins = users.filter((u) => u.role === "admin").length;
  const totpOn = users.filter((u) => u.totp_enabled).length;
  const inactive = users.filter((u) => !u.is_active).length;
  statRow.innerHTML = `
    <div class="stat-tile"><div class="label">Teammates</div><div class="value">${users.length}</div></div>
    <div class="stat-tile"><div class="label">Admins</div><div class="value">${admins}</div></div>
    <div class="stat-tile"><div class="label">2FA enabled</div><div class="value">${totpOn}</div></div>
    <div class="stat-tile"><div class="label">Inactive</div><div class="value">${inactive}</div></div>`;
}

function applyUserFilters() {
  const query = document.getElementById("user-search").value.trim().toLowerCase();
  const role = document.getElementById("role-filter").value;
  const filtered = allUsers.filter((u) => (!role || u.role === role) && (!query || u.email.toLowerCase().includes(query)));
  usersSortable.setRows(filtered);
}

// Event delegation on the (always-present) tbody, bound once -- sorting/filtering replaces
// its innerHTML on every change, which would silently drop per-row listeners bound the usual
// way (tbody.querySelectorAll(...).forEach(...)) after the first re-render.
document.querySelector("#users-table tbody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  if (btn.dataset.action === "access") {
    openAccessEditor(Number(btn.dataset.id), btn.dataset.email);
  } else if (btn.dataset.action === "toggle") {
    const isActive = btn.dataset.active === "true";
    await apiJson(`/api/admin/users/${btn.dataset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !isActive }),
    });
    loadUsers();
  } else if (btn.dataset.action === "reset-2fa") {
    if (!confirm(`Turn off two-factor auth for ${btn.dataset.email}? They'll need to re-enroll from their Security page.`)) return;
    await apiJson(`/api/admin/users/${btn.dataset.id}/reset-2fa`, { method: "POST" });
    loadUsers();
  }
});

document.getElementById("user-search").addEventListener("input", applyUserFilters);
document.getElementById("role-filter").addEventListener("change", applyUserFilters);

async function loadUsers() {
  allUsers = await apiJson("/api/admin/users");
  renderAdminStats(allUsers);

  if (!usersSortable) {
    usersSortable = attachSortableTable(document.getElementById("users-table"), [], USER_SORT_COMPARATORS, userRow, {
      field: "email",
      dir: 1,
    });
  }
  applyUserFilters();
}

document.getElementById("create-user-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("create-error");
  errorEl.style.display = "none";

  const email = document.getElementById("new-email").value.trim();
  const password = document.getElementById("new-password").value;
  const role = document.getElementById("new-role").value;

  if (!email || !password) {
    errorEl.textContent = "Email and password are required.";
    errorEl.style.display = "block";
    return;
  }

  try {
    await apiJson("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, role }),
    });
    document.getElementById("new-email").value = "";
    document.getElementById("new-password").value = "";
    loadUsers();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = "block";
  }
});

function buildCheckboxGrid(container, options, valueKey, labelKey, checkedKeys, namePrefix, noteFn) {
  container.innerHTML = "";
  if (options.length === 0) {
    container.innerHTML = `<span style="color: var(--text-muted); font-size: 13px;">None available.</span>`;
    return;
  }
  for (const opt of options) {
    const key = opt[valueKey];
    const label = opt[labelKey];
    const safeKey = escapeHtml(key);
    const safeLabel = escapeHtml(label);
    const note = noteFn ? escapeHtml(noteFn(opt)) : "";
    const id = `${namePrefix}-${String(key).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const wrapper = document.createElement("label");
    wrapper.innerHTML = `<input type="checkbox" id="${id}" value="${safeKey}" data-label="${safeLabel}" ${
      checkedKeys.has(String(key)) ? "checked" : ""
    } /> ${safeLabel}${note ? ` <span style="color: var(--text-muted); font-size: 11px;">${note}</span>` : ""}`;
    container.appendChild(wrapper);
  }
}

function readCheckedItems(container) {
  return Array.from(container.querySelectorAll("input[type='checkbox']:checked")).map((cb) => ({
    key: cb.value,
    label: cb.dataset.label,
  }));
}

async function openAccessEditor(userId, email) {
  selectedUserId = userId;
  document.getElementById("access-editor-title").textContent = `Manage access — ${email}`;
  document.getElementById("access-editor").style.display = "block";
  document.getElementById("access-saved-msg").style.display = "none";

  if (!adminOptions) {
    adminOptions = await apiJson("/api/admin/options");
  }
  const current = await apiJson(`/api/admin/users/${userId}/access`);

  buildCheckboxGrid(
    document.getElementById("pdf-lender-checkboxes"),
    adminOptions.pdf_lenders,
    "key",
    "label",
    new Set(current.pdf_lenders),
    "pdf",
    (opt) => (opt.has_reports ? "" : "(no reports yet)")
  );

  buildCheckboxGrid(
    document.getElementById("lender-checkboxes"),
    adminOptions.lenders,
    "lender_id",
    "lender_name",
    new Set(current.analytics_lenders),
    "lender"
  );

  document.getElementById("access-editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("save-access-btn").addEventListener("click", async () => {
  if (!selectedUserId) return;
  await apiJson(`/api/admin/users/${selectedUserId}/access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pdf_lenders: readCheckedItems(document.getElementById("pdf-lender-checkboxes")),
      analytics_lenders: readCheckedItems(document.getElementById("lender-checkboxes")),
    }),
  });
  document.getElementById("access-saved-msg").style.display = "inline";
});

document.getElementById("cancel-access-btn").addEventListener("click", () => {
  document.getElementById("access-editor").style.display = "none";
  selectedUserId = null;
});

loadUsers();
