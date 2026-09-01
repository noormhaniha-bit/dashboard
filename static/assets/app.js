const DOC_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M13 3v5h5"/><path d="M9 13h6M9 17h6"/></svg>`;
const FILE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M13 3v5h5"/></svg>`;
const EYE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const DOWNLOAD_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>`;
const CHEVRON_ICON = `<svg class="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

const NEW_WINDOW_SECONDS = 7 * 24 * 3600;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatPeriod(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long" });
}

function formatModified(epochSeconds) {
  if (!epochSeconds) return "--";
  return new Date(epochSeconds * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function isNew(epochSeconds) {
  return !!epochSeconds && Date.now() / 1000 - epochSeconds < NEW_WINDOW_SECONDS;
}

function flattenGroup(group) {
  return group.periods.flatMap((period) =>
    period.files.map((file) => ({
      lender: group.lender,
      lenderDisplay: group.lender_display_name || group.lender,
      period: period.period,
      name: file.name,
      url: `/api/pdf/${encodeURI(file.rel_path)}`,
      size_bytes: file.size_bytes,
      modified: file.modified,
    }))
  );
}

const REPORT_SORT_COMPARATORS = {
  period: (a, b) => a.period.localeCompare(b.period),
  name: (a, b) => a.name.localeCompare(b.name),
  size: (a, b) => a.size_bytes - b.size_bytes,
  modified: (a, b) => a.modified - b.modified,
};

function reportCell(row) {
  const badge = isNew(row.modified) ? `<span class="pill new">New</span>` : "";
  return `<span class="report-name" title="${escapeHtml(row.name)}">${FILE_ICON}${escapeHtml(row.name)}${badge}</span>`;
}

function actionsCell(row) {
  return `
    <div class="table-actions">
      <a class="icon-btn" href="${row.url}" target="_blank" rel="noopener" title="View">${EYE_ICON}</a>
      <a class="icon-btn" href="${row.url}" download="${escapeHtml(row.name)}" title="Download">${DOWNLOAD_ICON}</a>
    </div>`;
}

function renderLenderRow(row) {
  return `
    <tr>
      <td>${escapeHtml(formatPeriod(row.period))}</td>
      <td>${reportCell(row)}</td>
      <td>${formatBytes(row.size_bytes)}</td>
      <td>${formatModified(row.modified)}</td>
      <td>${actionsCell(row)}</td>
    </tr>`;
}

function renderRecentRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.lenderDisplay)}</td>
      <td>${reportCell(row)}</td>
      <td>${escapeHtml(formatPeriod(row.period))}</td>
      <td>${formatModified(row.modified)}</td>
      <td>${actionsCell(row)}</td>
    </tr>`;
}

const SORTABLE_COLUMNS = [
  { field: "period", label: "Period" },
  { field: "name", label: "Report" },
  { field: "size", label: "Size" },
  { field: "modified", label: "Modified" },
];

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function renderLenderSection(group) {
  const rows = flattenGroup(group);
  const displayName = group.lender_display_name || group.lender;

  const section = document.createElement("div");
  section.className = "card lender-section";
  section.dataset.lender = group.lender;
  section.dataset.search = [group.lender, group.lender_display_name, ...rows.map((r) => r.name)].join(" ").toLowerCase();

  const headerHtml = `
    <div class="lender-section-header">
      <div class="lender-section-title">
        <a href="/lender/${encodeURIComponent(slugify(displayName))}" class="lender-section-link">${DOC_ICON}<span>${escapeHtml(displayName)}</span></a>
      </div>
      <div class="lender-section-header-right">
        <span class="pill neutral">${rows.length} report${rows.length === 1 ? "" : "s"}</span>
        ${CHEVRON_ICON}
      </div>
    </div>`;

  const theadHtml = `
    <thead>
      <tr>
        ${SORTABLE_COLUMNS.map((c) => `<th class="sortable" data-field="${c.field}">${c.label}<span class="sort-indicator"></span></th>`).join("")}
        <th></th>
      </tr>
    </thead>`;

  section.innerHTML = `${headerHtml}<table>${theadHtml}<tbody></tbody></table>`;

  attachSortableTable(section.querySelector("table"), rows, REPORT_SORT_COMPARATORS, renderLenderRow, {
    field: "period",
    dir: -1,
  });

  section.querySelector(".lender-section-header").addEventListener("click", () => {
    section.classList.toggle("collapsed");
  });
  section.querySelector(".lender-section-link").addEventListener("click", (e) => e.stopPropagation());

  return section;
}

// renderRecentPanel/renderStats are unused on this page itself (Reports dropped its stats/recent
// panel to stay a focused list) -- they're kept here because Overview loads this file too and
// reuses them verbatim against the same #recent-card/#reports-stats element ids.
function renderRecentPanel(lenderGroups) {
  const card = document.getElementById("recent-card");
  const tbody = document.getElementById("recent-tbody");
  const rows = lenderGroups
    .flatMap(flattenGroup)
    .filter((r) => r.modified)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, 8);

  if (rows.length === 0) {
    card.style.display = "none";
    return;
  }

  tbody.innerHTML = rows.map(renderRecentRow).join("");
  card.style.display = "block";
}

function renderStats(lenderGroups) {
  const statRow = document.getElementById("reports-stats");
  const allFiles = lenderGroups.flatMap((g) => g.periods.flatMap((p) => p.files));
  const totalReports = allFiles.length;
  const totalBytes = allFiles.reduce((sum, f) => sum + f.size_bytes, 0);
  const latestPeriod = lenderGroups
    .flatMap((g) => g.periods.map((p) => p.period))
    .sort()
    .at(-1);

  statRow.innerHTML = `
    <div class="stat-tile"><div class="label">Lenders</div><div class="value">${lenderGroups.length}</div></div>
    <div class="stat-tile"><div class="label">Reports</div><div class="value">${totalReports}</div></div>
    <div class="stat-tile"><div class="label">Total size</div><div class="value">${formatBytes(totalBytes)}</div></div>
    <div class="stat-tile"><div class="label">Latest period</div><div class="value">${latestPeriod ? escapeHtml(formatPeriod(latestPeriod)) : "--"}</div></div>`;
}

function applyFilters() {
  const chosenLender = document.getElementById("lender-filter").value;
  const query = document.getElementById("report-search").value.trim().toLowerCase();

  let anyVisible = false;
  document.querySelectorAll(".lender-section").forEach((el) => {
    const matchesLender = !chosenLender || el.dataset.lender === chosenLender;
    const matchesQuery = !query || el.dataset.search.includes(query);
    const visible = matchesLender && matchesQuery;
    el.style.display = visible ? "" : "none";
    if (visible) anyVisible = true;
  });

  const noResults = document.getElementById("no-results-msg");
  if (noResults) noResults.style.display = anyVisible ? "none" : "block";
}

function populateLenderFilter(lenderGroups) {
  const select = document.getElementById("lender-filter");
  select.innerHTML = `<option value="">All lenders</option>`;
  for (const group of lenderGroups) {
    const opt = document.createElement("option");
    opt.value = group.lender;
    opt.textContent = group.lender_display_name || group.lender;
    select.appendChild(opt);
  }
  select.onchange = applyFilters;
}

function wireExpandCollapseAll() {
  document.getElementById("expand-all-btn").addEventListener("click", () => {
    document.querySelectorAll(".lender-section").forEach((el) => el.classList.remove("collapsed"));
  });
  document.getElementById("collapse-all-btn").addEventListener("click", () => {
    document.querySelectorAll(".lender-section").forEach((el) => el.classList.add("collapsed"));
  });
}

async function loadReports() {
  const list = document.getElementById("reports-list");
  if (!list) {
    // Shouldn't happen with a fresh page load, but a null list here means this script is
    // running against different markup than it expects (e.g. a stale cached page) -- fail
    // loudly in the console instead of throwing deep inside the try block below.
    console.error("loadReports: #reports-list not found in the page -- try a hard refresh (Ctrl+Shift+R).");
    return;
  }
  try {
    const res = await apiFetch("/api/reports");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      list.innerHTML = `<p class="empty-state">${escapeHtml(body.detail || "Could not load reports.")}</p>`;
      return;
    }
    const lenderGroups = await res.json();

    if (lenderGroups.length === 0) {
      list.innerHTML = `<p class="empty-state">No reports found under the configured directory.</p>`;
      return;
    }

    populateLenderFilter(lenderGroups);
    wireExpandCollapseAll();

    list.innerHTML = "";
    for (const group of lenderGroups) {
      list.appendChild(renderLenderSection(group));
    }
    const noResults = document.createElement("p");
    noResults.id = "no-results-msg";
    noResults.className = "empty-state";
    noResults.style.display = "none";
    noResults.textContent = "No reports match your search.";
    list.appendChild(noResults);

    document.getElementById("report-search").addEventListener("input", applyFilters);
  } catch {
    list.innerHTML = `<p class="empty-state">Could not reach the server.</p>`;
  }
}

// This file is also loaded (for its shared flattenGroup/renderLenderRow/REPORT_SORT_COMPARATORS
// helpers) by the single-lender detail page, which has no #reports-list -- only auto-run the
// full page behavior when we're actually on the PDF Reports page.
if (document.getElementById("reports-list")) loadReports();
