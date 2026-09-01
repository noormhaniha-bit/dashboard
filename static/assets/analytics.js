let catalog = [];
let paramInputs = {}; // name -> {el, spec}
let resultChart = null;
let resultsSortable = null;
let lastResultColumns = [];
let analyticsInitialized = false;

const RECENT_QUERIES_KEY = "analytics_recent_queries";
const REGION_KEY = "analytics_region";

function currentRegion() {
  return document.getElementById("region-select").value;
}

async function initRegionSelect() {
  const select = document.getElementById("region-select");
  let regions = [{ region: "US", configured: true }, { region: "EU", configured: true }, { region: "RBC", configured: true }];
  try {
    regions = await apiJson("/api/analytics/regions");
  } catch {
    // Fall back to all enabled -- the actual query call will surface a clearer 503 if a
    // region turns out not to be configured.
  }

  for (const opt of select.options) {
    const info = regions.find((r) => r.region === opt.value);
    if (info && !info.configured) {
      opt.disabled = true;
      opt.textContent = `${opt.value} (not configured)`;
    }
  }

  const saved = localStorage.getItem(REGION_KEY);
  const firstConfigured = regions.find((r) => r.configured)?.region;
  if (saved && !select.querySelector(`option[value="${saved}"]`)?.disabled) {
    select.value = saved;
  } else if (firstConfigured) {
    select.value = firstConfigured;
  }

  select.addEventListener("change", async () => {
    try {
      localStorage.setItem(REGION_KEY, select.value);
    } catch {
      // storage unavailable/full -- the selection still works for this load
    }
    await onQueryChange();
  });
}

function loadRecentQueries() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_QUERIES_KEY) || "[]");
  } catch {
    return [];
  }
}

function currentParamValues(spec) {
  const values = {};
  for (const p of spec.params) {
    const entry = paramInputs[p.name];
    if (entry) values[p.name] = entry.el.value;
  }
  return values;
}

function saveRecentQuery(spec) {
  const recent = [
    { id: spec.id, label: spec.label, params: currentParamValues(spec) },
    ...loadRecentQueries().filter((q) => q.id !== spec.id),
  ].slice(0, 5);
  try {
    localStorage.setItem(RECENT_QUERIES_KEY, JSON.stringify(recent));
  } catch {
    // storage unavailable or full -- the chips are a convenience, not worth failing the query run over
  }
  renderRecentQueries();
}

function renderRecentQueries() {
  const container = document.getElementById("recent-queries");
  const recent = loadRecentQueries().filter((q) => catalog.some((c) => c.id === q.id));
  if (recent.length === 0) {
    container.style.display = "none";
    return;
  }
  container.style.display = "flex";
  container.innerHTML = recent
    .map((q) => `<button type="button" class="chip" data-query-id="${escapeHtml(q.id)}">${escapeHtml(q.label)}</button>`)
    .join("");
  container.querySelectorAll(".chip").forEach((btn, i) => {
    btn.addEventListener("click", async () => {
      const preset = recent[i];
      document.getElementById("query-select").value = preset.id;
      await onQueryChange();
      const spec = catalog.find((c) => c.id === preset.id);
      if (spec) await applySavedParams(spec, preset.params);
    });
  });
}

function seriesColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function populateSelectFromApi(selectEl, url, valueKey, labelKey, placeholder) {
  try {
    const rows = await apiJson(url);
    selectEl.innerHTML = `<option value="">${placeholder}</option>`;
    for (const row of rows) {
      const opt = document.createElement("option");
      opt.value = row[valueKey];
      opt.textContent = row[labelKey];
      selectEl.appendChild(opt);
    }
  } catch (err) {
    selectEl.innerHTML = `<option value="">Unavailable: ${err.message}</option>`;
  }
}

function defaultForParam(p) {
  if (p.default !== null && p.default !== undefined) return p.default;
  if (p.type === "date") {
    if (p.name === "date_to") return todayIso();
    if (p.name === "date_from") return daysAgoIso(30);
  }
  return "";
}

async function renderParamInputs(spec) {
  const container = document.getElementById("param-inputs");
  container.innerHTML = "";
  paramInputs = {};

  // When a query takes both a lender and a merchant, the merchant list should only ever
  // show merchants under the chosen lender -- so the merchant select starts disabled and
  // only fills in once a lender is picked, instead of listing every merchant up front.
  const hasLenderParam = spec.params.some((p) => p.type === "lender_select");
  let lenderSelectEl = null;

  for (const p of spec.params) {
    const label = document.createElement("label");
    const captionText = p.required ? p.label : `${p.label} (optional)`;
    label.innerHTML = `<span></span>`;
    label.firstChild.textContent = captionText;

    let inputEl;
    if (p.type === "lender_select") {
      inputEl = document.createElement("select");
      label.appendChild(inputEl);
      container.appendChild(label);
      paramInputs[p.name] = { el: inputEl, spec: p };
      await populateSelectFromApi(
        inputEl,
        `/api/analytics/lenders?region=${encodeURIComponent(currentRegion())}`,
        "lender_id",
        "lender_name",
        "Select a lender"
      );
      lenderSelectEl = inputEl;
      continue;
    } else if (p.type === "merchant_select") {
      inputEl = document.createElement("select");
      label.appendChild(inputEl);
      container.appendChild(label);
      paramInputs[p.name] = { el: inputEl, spec: p };
      if (hasLenderParam) {
        inputEl.innerHTML = `<option value="">Select a lender first</option>`;
        inputEl.disabled = true;
      } else {
        await populateSelectFromApi(
          inputEl,
          `/api/analytics/merchants?region=${encodeURIComponent(currentRegion())}`,
          "merchant_id",
          "merchant_name",
          "Select a merchant"
        );
      }
      continue;
    } else if (p.type === "date") {
      inputEl = document.createElement("input");
      inputEl.type = "date";
    } else if (p.type === "number") {
      inputEl = document.createElement("input");
      inputEl.type = "number";
    } else {
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.placeholder = p.label;
    }

    inputEl.value = defaultForParam(p);
    label.appendChild(inputEl);
    container.appendChild(label);
    paramInputs[p.name] = { el: inputEl, spec: p };
  }

  if (lenderSelectEl) {
    const merchantEntry = Object.values(paramInputs).find((e) => e.spec.type === "merchant_select");
    if (merchantEntry) {
      lenderSelectEl.addEventListener("change", () => populateMerchantsForLender(lenderSelectEl, merchantEntry));
    }
  }
}

// Factored out of the lender-select "change" listener so restoring a saved query preset (or a
// deep link) can trigger the same real repopulation and await it, instead of faking a DOM event.
async function populateMerchantsForLender(lenderSelectEl, merchantEntry) {
  const lenderId = lenderSelectEl.value;
  if (!lenderId) {
    merchantEntry.el.innerHTML = `<option value="">Select a lender first</option>`;
    merchantEntry.el.disabled = true;
    return;
  }
  merchantEntry.el.disabled = false;
  merchantEntry.el.innerHTML = `<option value="">Loading…</option>`;
  await populateSelectFromApi(
    merchantEntry.el,
    `/api/analytics/merchants?region=${encodeURIComponent(currentRegion())}&lender_id=${encodeURIComponent(lenderId)}`,
    "merchant_id",
    "merchant_name",
    "Select a merchant"
  );
}

// Applies saved/deep-linked param values in spec-declared order (lender before merchant is
// guaranteed by every catalog entry's own param order) so the lender->merchant cascade above
// runs for real before the merchant value is set, rather than racing an async repopulation.
async function applySavedParams(spec, savedParams) {
  if (!savedParams) return;
  for (const p of spec.params) {
    const value = savedParams[p.name];
    if (value === undefined || value === null || value === "") continue;
    const entry = paramInputs[p.name];
    if (!entry) continue;

    entry.el.value = value;
    if (p.type === "lender_select") {
      const merchantEntry = Object.values(paramInputs).find((e) => e.spec.type === "merchant_select");
      if (merchantEntry) await populateMerchantsForLender(entry.el, merchantEntry);
    }
  }
}

function buildQueryString(spec) {
  const parts = [`query_id=${encodeURIComponent(spec.id)}`, `region=${encodeURIComponent(currentRegion())}`];
  for (const p of spec.params) {
    const value = paramInputs[p.name]?.el.value ?? "";
    if (value === "" && !p.required) continue;
    if (value === "" && p.required) {
      throw new Error(`"${p.label}" is required.`);
    }
    parts.push(`${p.name}=${encodeURIComponent(value)}`);
  }
  return parts.join("&");
}

function genericComparator(col) {
  return (a, b) => {
    const av = a[col];
    const bv = b[col];
    if (av == null && bv == null) return 0;
    if (av == null) return -1;
    if (bv == null) return 1;
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    return String(av).localeCompare(String(bv));
  };
}

function renderTable(columns, rows) {
  const table = document.getElementById("result-table");
  const thead = table.querySelector("thead");

  lastResultColumns = columns;
  thead.innerHTML = `<tr>${columns
    .map((c) => `<th class="sortable" data-field="${escapeHtml(c)}">${escapeHtml(c)}<span class="sort-indicator"></span></th>`)
    .join("")}</tr>`;

  const renderRow = (row) => `<tr>${columns.map((c) => `<td>${escapeHtml(row[c] ?? "")}</td>`).join("")}</tr>`;
  const comparators = Object.fromEntries(columns.map((c) => [c, genericComparator(c)]));
  resultsSortable = attachSortableTable(table, rows, comparators, renderRow);

  document.getElementById("row-count").textContent = rows.length;
  document.getElementById("table-card").style.display = "block";
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportResultsCsv() {
  if (!resultsSortable || lastResultColumns.length === 0) return;
  const rows = resultsSortable.getRows();
  const lines = [lastResultColumns.map(csvEscape).join(",")];
  for (const row of rows) lines.push(lastResultColumns.map((c) => csvEscape(row[c])).join(","));

  const spec = catalog.find((q) => q.id === document.getElementById("query-select").value);
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${spec?.id || "analytics-results"}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById("export-csv-btn").addEventListener("click", exportResultsCsv);

function countBy(rows, xField) {
  const counts = new Map();
  for (const row of rows) {
    const key = row[xField] ?? "(none)";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return { labels: [...counts.keys()], values: [...counts.values()] };
}

function renderChart(chartSpec, columns, rows) {
  const card = document.getElementById("chart-card");
  const canvas = document.getElementById("result-chart");

  if (!chartSpec || rows.length === 0) {
    card.style.display = "none";
    if (resultChart) resultChart.destroy();
    return;
  }

  const palette = [seriesColor("--series-1"), seriesColor("--series-2")];
  let labels, datasets;

  if (chartSpec.kind === "count_by") {
    const { labels: l, values } = countBy(rows, chartSpec.x);
    labels = l;
    datasets = [{ label: "Count", data: values, backgroundColor: palette[0] }];
  } else if (chartSpec.kind === "xy" && chartSpec.x === null) {
    // single-row aggregate -- one bar per metric column
    labels = chartSpec.y;
    datasets = [{ label: "Value", data: chartSpec.y.map((k) => Number(rows[0]?.[k]) || 0), backgroundColor: palette[0] }];
  } else {
    labels = rows.map((r) => r[chartSpec.x]);
    datasets = chartSpec.y.map((field, i) => ({
      label: field,
      data: rows.map((r) => Number(r[field]) || 0),
      backgroundColor: palette[i % palette.length],
      borderColor: palette[i % palette.length],
      tension: 0.2,
    }));
  }

  if (resultChart) resultChart.destroy();
  resultChart = new Chart(canvas, {
    type: chartSpec.type === "line" ? "line" : "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      scales: {
        y: { beginAtZero: true, grid: { color: seriesColor("--gridline") } },
        x: { grid: { display: false } },
      },
    },
  });

  document.getElementById("chart-title").textContent = document.getElementById("query-select").selectedOptions[0]?.textContent || "Chart";
  card.style.display = "block";
}

let currentApplicationId = null;

function updateFullStoryActionCard(spec) {
  const card = document.getElementById("fullstory-action-card");
  const hasAppIdParam = spec.params.some((p) => p.name === "application_id");
  currentApplicationId = hasAppIdParam ? paramInputs["application_id"]?.el.value.trim() || null : null;

  if (!currentApplicationId) {
    card.style.display = "none";
    return;
  }
  document.getElementById("fullstory-action-text").textContent = `ApplicationID: ${currentApplicationId}`;
  document.getElementById("fullstory-action-result").textContent = "";
  card.style.display = "block";
}

async function recordCurrentSession() {
  if (!currentApplicationId) return;
  const btn = document.getElementById("record-session-btn");
  const resultEl = document.getElementById("fullstory-action-result");
  btn.disabled = true;
  resultEl.textContent = "Starting…";
  try {
    const formData = new FormData();
    formData.append("application_ids", currentApplicationId);
    const job = await apiJson("/api/fullstory/jobs", { method: "POST", body: formData });
    const link = `/fullstory?job=${encodeURIComponent(job.id)}`;
    resultEl.innerHTML = `Started job ${escapeHtml(job.id)} -- <a href="${link}">view progress on FullStory →</a>`;
  } catch (err) {
    resultEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("record-session-btn").addEventListener("click", recordCurrentSession);

async function runSelectedQuery() {
  const spec = catalog.find((q) => q.id === document.getElementById("query-select").value);
  const errorEl = document.getElementById("results-error");
  const statusEl = document.getElementById("run-status");
  errorEl.style.display = "none";
  if (!spec) return;

  let qs;
  try {
    qs = buildQueryString(spec);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = "block";
    return;
  }

  statusEl.style.display = "inline";
  statusEl.textContent = "Running…";
  try {
    const result = await apiJson(`/api/analytics/run?${qs}`);
    renderTable(result.columns, result.rows);
    renderChart(result.chart, result.columns, result.rows);
    saveRecentQuery(spec);
    updateFullStoryActionCard(spec);
    if (result.rows.length === 0) {
      errorEl.textContent = "No rows returned.";
      errorEl.style.display = "block";
    }
  } catch (err) {
    document.getElementById("fullstory-action-card").style.display = "none";
    errorEl.textContent = err.message;
    errorEl.style.display = "block";
    document.getElementById("table-card").style.display = "none";
    document.getElementById("chart-card").style.display = "none";
  } finally {
    statusEl.style.display = "none";
  }
}

async function onQueryChange() {
  const spec = catalog.find((q) => q.id === document.getElementById("query-select").value);
  document.getElementById("query-description").textContent = spec?.description || "";
  document.getElementById("results-error").style.display = "none";
  document.getElementById("table-card").style.display = "none";
  document.getElementById("chart-card").style.display = "none";
  document.getElementById("fullstory-action-card").style.display = "none";
  if (spec) await renderParamInputs(spec);
}

async function initAnalytics() {
  if (analyticsInitialized) return;
  analyticsInitialized = true;

  await initRegionSelect();

  const select = document.getElementById("query-select");
  try {
    catalog = await apiJson("/api/analytics/catalog");
  } catch (err) {
    select.innerHTML = `<option value="">${err.message}</option>`;
    return;
  }

  const categories = [...new Set(catalog.map((q) => q.category))];
  select.innerHTML = categories
    .map(
      (cat) =>
        `<optgroup label="${escapeHtml(cat)}">${catalog
          .filter((q) => q.category === cat)
          .map((q) => `<option value="${q.id}">${escapeHtml(q.label)}</option>`)
          .join("")}</optgroup>`
    )
    .join("");

  renderRecentQueries();
  select.addEventListener("change", onQueryChange);
  document.getElementById("run-query-btn").addEventListener("click", runSelectedQuery);

  await onQueryChange();
  await applyDeepLinkFromUrl();
}

// Lets another page (e.g. the global command palette's "look up application" action) link
// straight into a specific query, pre-filled and run -- same shape as FullStory's own ?job=
// deep link. Example: /analytics?query=application_lookup&application_id=<id>
async function applyDeepLinkFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const queryId = params.get("query");
  if (!queryId) return;

  const spec = catalog.find((q) => q.id === queryId);
  if (!spec) return;

  const region = params.get("region");
  const regionSelect = document.getElementById("region-select");
  if (region && !regionSelect.querySelector(`option[value="${region}"]`)?.disabled) {
    regionSelect.value = region;
  }

  document.getElementById("query-select").value = queryId;
  await onQueryChange();

  const values = {};
  for (const p of spec.params) {
    if (params.has(p.name)) values[p.name] = params.get(p.name);
  }
  await applySavedParams(spec, values);
  await runSelectedQuery();
}

initAnalytics();
