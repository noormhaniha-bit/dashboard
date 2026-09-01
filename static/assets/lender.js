const LENDER_MERCHANT_COMPARATORS = {
  merchant_name: (a, b) => (a.merchant_name || "").localeCompare(b.merchant_name || ""),
  status: (a, b) => (a.status || "").localeCompare(b.status || ""),
  date_created: (a, b) => new Date(a.date_created || 0) - new Date(b.date_created || 0),
};

function renderMerchantRow(m) {
  return `<tr>
      <td>${escapeHtml(m.merchant_name || "")}</td>
      <td>${escapeHtml(m.status || "")}</td>
      <td>${m.date_created ? new Date(m.date_created).toLocaleDateString() : "--"}</td>
    </tr>`;
}

function currentLenderSlug() {
  const parts = window.location.pathname.split("/").filter(Boolean); // ["lender", "<slug>"]
  return decodeURIComponent(parts[1] || "");
}

async function loadLenderReports(lender) {
  const container = document.getElementById("lender-reports-body");
  try {
    const groups = await apiJson("/api/reports");
    const group = groups.find((g) => g.lender === lender.folder_key);
    if (!group || group.periods.length === 0) {
      container.innerHTML = `<p class="empty-state">No reports yet for ${escapeHtml(lender.name)}.</p>`;
      return;
    }

    const rows = flattenGroup(group);
    container.innerHTML = `
      <table id="lender-reports-table">
        <thead>
          <tr>
            <th class="sortable" data-field="period">Period<span class="sort-indicator"></span></th>
            <th class="sortable" data-field="name">Report<span class="sort-indicator"></span></th>
            <th class="sortable" data-field="size">Size<span class="sort-indicator"></span></th>
            <th class="sortable" data-field="modified">Modified<span class="sort-indicator"></span></th>
            <th></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>`;
    attachSortableTable(document.getElementById("lender-reports-table"), rows, REPORT_SORT_COMPARATORS, renderLenderRow, {
      field: "period",
      dir: -1,
    });
  } catch (err) {
    container.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
  }
}

async function loadLenderAnalytics(lender) {
  const container = document.getElementById("lender-analytics-body");
  let sqlLenders;
  try {
    sqlLenders = await apiJson("/api/analytics/lenders");
  } catch (err) {
    container.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    return;
  }

  const match = sqlLenders.find((l) => l.lender_name.trim().toLowerCase() === lender.name.trim().toLowerCase());
  if (!match) {
    container.innerHTML = `<p class="empty-state">No analytics access or data for ${escapeHtml(lender.name)}.</p>`;
    return;
  }

  const dateTo = new Date().toISOString().slice(0, 10);
  const dateFrom = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  try {
    const perf = await apiJson(
      `/api/analytics/run?query_id=lender_performance&lender_id=${encodeURIComponent(match.lender_id)}&date_from=${dateFrom}&date_to=${dateTo}`
    );
    const row = perf.rows[0] || {};
    const approvalRate = row.approval_rate != null ? `${(row.approval_rate * 100).toFixed(1)}%` : "--";
    const avgAmount =
      row.avg_approved_amount != null
        ? Number(row.avg_approved_amount).toLocaleString(undefined, { style: "currency", currency: "USD" })
        : "--";

    container.innerHTML = `
      <div class="stat-row" style="margin-bottom: 18px">
        <div class="stat-tile"><div class="label">Applications</div><div class="value">${row.total_applications ?? 0}</div></div>
        <div class="stat-tile"><div class="label">Approved</div><div class="value">${row.approved_count ?? 0}</div></div>
        <div class="stat-tile"><div class="label">Approval rate</div><div class="value">${approvalRate}</div></div>
        <div class="stat-tile"><div class="label">Avg approved amount</div><div class="value">${avgAmount}</div></div>
      </div>
      <table id="lender-merchants-table">
        <thead>
          <tr>
            <th class="sortable" data-field="merchant_name">Merchant<span class="sort-indicator"></span></th>
            <th class="sortable" data-field="status">Status<span class="sort-indicator"></span></th>
            <th class="sortable" data-field="date_created">Created<span class="sort-indicator"></span></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>`;

    const merchants = await apiJson(`/api/analytics/run?query_id=merchants_by_lender&lender_id=${encodeURIComponent(match.lender_id)}`);
    attachSortableTable(document.getElementById("lender-merchants-table"), merchants.rows, LENDER_MERCHANT_COMPARATORS, renderMerchantRow, {
      field: "merchant_name",
      dir: 1,
    });
  } catch (err) {
    container.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
  }
}

async function loadLenderDetail() {
  const slug = currentLenderSlug();
  let lenderList;
  try {
    lenderList = await apiJson("/api/lenders");
  } catch (err) {
    document.getElementById("lender-title").textContent = "Error";
    document.getElementById("not-found-message").textContent = err.message;
    document.getElementById("not-found-card").style.display = "block";
    return;
  }

  const lender = lenderList.find((l) => l.slug === slug);
  if (!lender) {
    document.getElementById("lender-title").textContent = "Lender not found";
    document.getElementById("not-found-card").style.display = "block";
    return;
  }

  document.title = `${lender.name} — Ops Dashboard`;
  document.getElementById("lender-title").textContent = lender.name;
  document.getElementById("lender-content").style.display = "block";

  await Promise.all([loadLenderReports(lender), loadLenderAnalytics(lender)]);
}

loadLenderDetail();
