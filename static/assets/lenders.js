async function loadLenders() {
  const grid = document.getElementById("lenders-grid");
  try {
    const lenders = await apiJson("/api/lenders");
    if (lenders.length === 0) {
      grid.innerHTML = `<p class="empty-state">No lenders you have access to yet -- ask an admin to grant you one from the Admin page.</p>`;
      return;
    }
    grid.innerHTML = lenders
      .map(
        (l) => `
      <a class="lender-card" href="/lender/${encodeURIComponent(l.slug)}">
        <div class="lender-card-name">${escapeHtml(l.name)}</div>
        <span class="pill ${l.has_reports ? "success" : "neutral"}">${l.has_reports ? "Reports" : "No reports yet"}</span>
      </a>`
      )
      .join("");
  } catch (err) {
    grid.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
  }
}

loadLenders();
