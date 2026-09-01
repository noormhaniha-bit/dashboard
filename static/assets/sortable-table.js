/**
 * Wires click-to-sort behavior onto a <table> whose <thead> has `th.sortable[data-field]`
 * cells (each containing a `span.sort-indicator`) and whose data rows are rendered into
 * <tbody> by `renderRowFn`. Shared by every page with a sortable data table (Reports, Admin,
 * FullStory, Analytics) instead of each reimplementing the same sort/re-render/indicator logic.
 */
function attachSortableTable(tableEl, rows, comparators, renderRowFn, { field = null, dir = 1 } = {}) {
  const state = { field, dir };
  let data = rows;

  function sortData() {
    const cmp = state.field && comparators[state.field];
    if (!cmp) return;
    data = [...data].sort((a, b) => cmp(a, b) * state.dir);
  }

  function renderBody() {
    tableEl.querySelector("tbody").innerHTML = data.map(renderRowFn).join("");
  }

  function updateIndicators() {
    tableEl.querySelectorAll("th.sortable").forEach((th) => {
      const indicator = th.querySelector(".sort-indicator");
      if (!indicator) return;
      indicator.textContent = th.dataset.field === state.field ? (state.dir === 1 ? "▲" : "▼") : "";
    });
  }

  function refresh() {
    sortData();
    renderBody();
    updateIndicators();
  }

  tableEl.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const f = th.dataset.field;
      state.dir = state.field === f ? -state.dir : 1;
      state.field = f;
      refresh();
    });
  });

  refresh();

  return {
    getRows: () => data,
    setRows(newRows) {
      data = newRows;
      refresh();
    },
  };
}
