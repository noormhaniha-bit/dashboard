let allActivity = [];
let activitySortable = null;

const ACTIVITY_SORT_COMPARATORS = {
  created_at: (a, b) => new Date(a.created_at) - new Date(b.created_at),
  user_email: (a, b) => a.user_email.localeCompare(b.user_email),
  action: (a, b) => a.action.localeCompare(b.action),
  resource: (a, b) => (a.resource || "").localeCompare(b.resource || ""),
};

const ACTIVITY_ACTION_LABELS = {
  pdf_access: "PDF access",
  user_create: "Teammate created",
  user_update: "Teammate updated",
  "2fa_reset": "2FA reset",
  access_grant_change: "Access changed",
  fullstory_job_start: "FullStory job started",
};

function activityRow(row) {
  const when = new Date(row.created_at).toLocaleString();
  const label = ACTIVITY_ACTION_LABELS[row.action] || row.action;
  return `<tr>
      <td>${escapeHtml(when)}</td>
      <td>${escapeHtml(row.user_email)}</td>
      <td>${escapeHtml(label)}</td>
      <td>${escapeHtml(row.resource || "--")}</td>
      <td style="color: var(--text-muted)">${escapeHtml(row.detail || "")}</td>
    </tr>`;
}

function populateActionFilter(rows) {
  const select = document.getElementById("action-filter");
  const actions = [...new Set(rows.map((r) => r.action))].sort();
  select.innerHTML =
    `<option value="">All actions</option>` +
    actions.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(ACTIVITY_ACTION_LABELS[a] || a)}</option>`).join("");
}

function applyActivityFilters() {
  const query = document.getElementById("activity-search").value.trim().toLowerCase();
  const action = document.getElementById("action-filter").value;
  const filtered = allActivity.filter((r) => {
    if (action && r.action !== action) return false;
    if (!query) return true;
    return (
      r.user_email.toLowerCase().includes(query) ||
      r.action.toLowerCase().includes(query) ||
      (r.resource || "").toLowerCase().includes(query) ||
      (r.detail || "").toLowerCase().includes(query)
    );
  });
  activitySortable.setRows(filtered);
}

document.getElementById("activity-search").addEventListener("input", applyActivityFilters);
document.getElementById("action-filter").addEventListener("change", applyActivityFilters);

async function loadActivity() {
  const tableWrap = document.getElementById("activity-table").closest(".card");
  try {
    allActivity = await apiJson("/api/admin/activity");
  } catch (err) {
    tableWrap.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    return;
  }

  populateActionFilter(allActivity);
  if (!activitySortable) {
    activitySortable = attachSortableTable(document.getElementById("activity-table"), [], ACTIVITY_SORT_COMPARATORS, activityRow, {
      field: "created_at",
      dir: -1,
    });
  }
  applyActivityFilters();
}

loadActivity();
