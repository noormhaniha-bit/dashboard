let pollTimer = null;
let viewedJobId = null;
let allJobs = [];
let jobsSortable = null;

const JOB_SORT_COMPARATORS = {
  id: (a, b) => a.id.localeCompare(b.id),
  requested_by: (a, b) => a.requested_by.localeCompare(b.requested_by),
  status: (a, b) => a.status.localeCompare(b.status),
  started_at: (a, b) => (a.started_at || 0) - (b.started_at || 0),
};

function fmtTime(epochSeconds) {
  if (!epochSeconds) return "--";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function formatDuration(job) {
  if (!job.started_at || !job.finished_at) return "--";
  const totalSeconds = Math.max(0, Math.round(job.finished_at - job.started_at));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s}s`;
}

function statusLabel(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatAppIds(ids, max = 3) {
  if (ids.length <= max) return ids.join(", ");
  return `${ids.slice(0, max).join(", ")} +${ids.length - max} more`;
}

function renderActiveJob(job) {
  document.getElementById("active-job-card").style.display = "block";
  document.getElementById("active-job-id").textContent = job.id;
  document.getElementById("active-job-app-id-count").textContent = job.application_ids.length;
  document.getElementById("active-job-app-ids").textContent = job.application_ids.join(", ");

  const statusEl = document.getElementById("active-job-status");
  statusEl.textContent = statusLabel(job.status);
  statusEl.className = `pill ${job.status}`;

  const logEl = document.getElementById("active-job-log");
  const wasAtBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
  logEl.textContent = (job.log || []).join("\n");
  if (wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
}

async function pollJob(jobId) {
  let job;
  try {
    job = await apiJson(`/api/fullstory/jobs/${encodeURIComponent(jobId)}`);
  } catch {
    return;
  }
  if (viewedJobId !== jobId) return; // user switched to a different job while this was in flight

  renderActiveJob(job);

  if (job.status === "queued" || job.status === "running") {
    pollTimer = setTimeout(() => pollJob(jobId), 2000);
  } else {
    pollTimer = null;
    await loadJobsTable();
  }
}

function watchJob(jobId) {
  if (pollTimer) clearTimeout(pollTimer);
  viewedJobId = jobId;
  pollJob(jobId);
}

function jobRow(job) {
  return `<tr data-job-id="${escapeHtml(job.id)}" style="cursor: pointer">
      <td>${escapeHtml(job.id)}</td>
      <td>${escapeHtml(formatAppIds(job.application_ids))}</td>
      <td>${escapeHtml(job.requested_by)}</td>
      <td><span class="pill ${job.status}">${escapeHtml(statusLabel(job.status))}</span></td>
      <td>${escapeHtml(fmtTime(job.started_at))}</td>
      <td>${formatDuration(job)}</td>
    </tr>`;
}

function renderFullStoryStats(jobs) {
  const statRow = document.getElementById("fullstory-stats");
  const running = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const success = jobs.filter((j) => j.status === "success").length;
  const failed = jobs.filter((j) => j.status === "failed").length;
  statRow.innerHTML = `
    <div class="stat-tile"><div class="label">Total jobs</div><div class="value">${jobs.length}</div></div>
    <div class="stat-tile"><div class="label">Running now</div><div class="value">${running}</div></div>
    <div class="stat-tile"><div class="label">Success</div><div class="value">${success}</div></div>
    <div class="stat-tile"><div class="label">Failed</div><div class="value">${failed}</div></div>`;
}

function applyJobFilters() {
  const query = document.getElementById("job-search").value.trim().toLowerCase();
  const filtered = !query
    ? allJobs
    : allJobs.filter(
        (j) =>
          j.id.toLowerCase().includes(query) ||
          j.requested_by.toLowerCase().includes(query) ||
          j.application_ids.some((id) => id.toLowerCase().includes(query))
      );
  jobsSortable.setRows(filtered);
}

// Event delegation on the (always-present) tbody, bound once -- sorting/filtering replaces
// its innerHTML on every change, which would drop a per-row click listener bound the usual way.
document.querySelector("#jobs-table tbody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-job-id]");
  if (tr) watchJob(tr.dataset.jobId);
});

document.getElementById("job-search").addEventListener("input", applyJobFilters);

async function loadJobsTable() {
  try {
    allJobs = await apiJson("/api/fullstory/jobs");
  } catch {
    return;
  }
  renderFullStoryStats(allJobs);
  if (!jobsSortable) {
    jobsSortable = attachSortableTable(document.getElementById("jobs-table"), [], JOB_SORT_COMPARATORS, jobRow, {
      field: "started_at",
      dir: -1,
    });
  }
  applyJobFilters();
  return allJobs;
}

async function startJob() {
  const textInput = document.getElementById("app-ids-input");
  const fileInput = document.getElementById("app-ids-file");
  const errorEl = document.getElementById("start-error");
  const btn = document.getElementById("record-btn");
  errorEl.style.display = "none";

  const pastedText = textInput.value.trim();
  const file = fileInput.files[0] || null;
  if (!pastedText && !file) {
    errorEl.textContent = "Paste at least one applicationId and/or choose a file.";
    errorEl.style.display = "block";
    return;
  }

  const formData = new FormData();
  formData.append("application_ids", pastedText);
  if (file) formData.append("file", file);

  btn.disabled = true;
  try {
    const job = await apiJson("/api/fullstory/jobs", { method: "POST", body: formData });
    textInput.value = "";
    fileInput.value = "";
    await loadJobsTable();
    watchJob(job.id);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = "block";
  } finally {
    btn.disabled = false;
  }
}

async function initFullStory() {
  document.getElementById("record-btn").addEventListener("click", startJob);

  const jobs = await loadJobsTable();

  // A deep link from Analytics ("Record FullStory session" on an application lookup) lands
  // here with ?job=<id> -- jump straight to that job's live log instead of making the user
  // find it in the table themselves.
  const linkedJobId = new URLSearchParams(window.location.search).get("job");
  if (linkedJobId && (jobs || []).some((j) => j.id === linkedJobId)) {
    watchJob(linkedJobId);
    return;
  }

  const active = (jobs || []).find((j) => j.status === "queued" || j.status === "running");
  if (active) watchJob(active.id);
}

initFullStory();
