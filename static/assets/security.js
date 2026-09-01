function showView(name) {
  document.getElementById("disabled-view").style.display = name === "disabled" ? "block" : "none";
  document.getElementById("setup-view").style.display = name === "setup" ? "block" : "none";
  document.getElementById("enabled-view").style.display = name === "enabled" ? "block" : "none";
}

function setStatusPill(enabled) {
  const pill = document.getElementById("status-pill");
  pill.textContent = enabled ? "On" : "Off";
  pill.className = `pill ${enabled ? "on" : "off"}`;
}

async function refreshStatus() {
  const { enabled } = await apiJson("/api/security/2fa/status");
  setStatusPill(enabled);
  showView(enabled ? "enabled" : "disabled");
}

document.getElementById("start-setup-btn").addEventListener("click", async () => {
  const { secret, qr_code_data_uri } = await apiJson("/api/security/2fa/setup", { method: "POST" });
  document.getElementById("qr-code-img").src = qr_code_data_uri;
  document.getElementById("secret-key-text").textContent = secret;
  document.getElementById("confirm-code-input").value = "";
  document.getElementById("setup-error").style.display = "none";
  showView("setup");
});

document.getElementById("cancel-setup-btn").addEventListener("click", () => {
  showView("disabled");
});

document.getElementById("confirm-setup-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("setup-error");
  errorEl.style.display = "none";
  const code = document.getElementById("confirm-code-input").value.trim();

  try {
    await apiJson("/api/security/2fa/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    await refreshStatus();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = "block";
  }
});

document.getElementById("disable-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("disable-error");
  errorEl.style.display = "none";
  const code = document.getElementById("disable-code-input").value.trim();

  try {
    await apiJson("/api/security/2fa/disable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    document.getElementById("disable-code-input").value = "";
    await refreshStatus();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = "block";
  }
});

refreshStatus();
