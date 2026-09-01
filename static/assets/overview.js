async function loadReportsOverview() {
  try {
    const lenderGroups = await apiJson("/api/reports");
    if (lenderGroups.length > 0) {
      renderStats(lenderGroups); // from app.js, targets #reports-stats
      renderRecentPanel(lenderGroups); // from app.js, targets #recent-card/#recent-tbody
    } else {
      document.getElementById("reports-stats").innerHTML = `<p class="empty-state">No reports found yet.</p>`;
    }
  } catch (err) {
    document.getElementById("reports-stats").innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
  }
}

async function loadMonitoringOverview() {
  const statRow = document.getElementById("monitoring-stats");
  try {
    // US and EU are separate databases -- combine the stuck-applications count across every
    // configured region rather than picking just one for this at-a-glance tile.
    // allSettled (not all) so one region being down (e.g. a login failure on its DB) still
    // shows the working regions' count instead of blanking the whole tile.
    const regions = await apiJson("/api/analytics/regions");
    const settled = await Promise.allSettled(
      regions
        .filter((r) => r.configured)
        .map((r) =>
          apiJson(`/api/analytics/run?query_id=stuck_applications_overview&threshold_hours=4&region=${r.region}`)
        )
    );
    const results = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
    const failedCount = settled.filter((s) => s.status === "rejected").length;

    if (results.length === 0 && failedCount > 0) {
      throw new Error("Unavailable -- all configured regions failed to respond.");
    }

    // Each query caps at 500 rows (see get_stuck_applications_overview) -- a region hitting
    // that cap means there are at least that many, not exactly, so say so rather than
    // showing a false-precision exact combined count.
    const cappedAny = results.some((r) => r.rows.length >= 500);
    const total = results.reduce((sum, r) => sum + r.rows.length, 0);
    const displayCount = cappedAny ? `${total}+` : String(total);
    const valueColor = total > 0 ? "var(--status-critical)" : "var(--status-good)";
    const partialNote =
      failedCount > 0 ? `<div class="subtitle" style="margin-top: 4px">${failedCount} region(s) unavailable</div>` : "";
    statRow.innerHTML = `
      <div class="stat-tile">
        <div class="label">Stuck applications (4h+)</div>
        <div class="value" style="color: ${valueColor}">${displayCount}</div>
        ${partialNote}
      </div>`;
  } catch (err) {
    statRow.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
  }
}

async function loadFullStoryOverview() {
  const statRow = document.getElementById("fullstory-overview-stats");
  try {
    const jobs = await apiJson("/api/fullstory/jobs");
    const running = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
    const success = jobs.filter((j) => j.status === "success").length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    statRow.innerHTML = `
      <div class="stat-tile"><div class="label">Total jobs</div><div class="value">${jobs.length}</div></div>
      <div class="stat-tile"><div class="label">Running now</div><div class="value">${running}</div></div>
      <div class="stat-tile"><div class="label">Success</div><div class="value">${success}</div></div>
      <div class="stat-tile"><div class="label">Failed</div><div class="value">${failed}</div></div>`;
  } catch (err) {
    statRow.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
  }
}

async function loadLendersOverview() {
  const countEl = document.getElementById("accessible-lenders-count");
  try {
    const lenders = await apiJson("/api/lenders");
    countEl.textContent = lenders.length;
  } catch {
    countEl.textContent = "--";
  }
}

document.getElementById("browse-lenders-btn").addEventListener("click", () => {
  window.location.href = "/lenders";
});

loadReportsOverview();
loadMonitoringOverview();
loadFullStoryOverview();
loadLendersOverview();
