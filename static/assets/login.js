let pendingToken = null;

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("error");
  const submitBtn = document.getElementById("submit-btn");
  errorEl.style.display = "none";
  submitBtn.disabled = true;
  submitBtn.textContent = "Signing in…";

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("email").value,
        password: document.getElementById("password").value,
      }),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      errorEl.textContent = body.detail || "Sign in failed.";
      errorEl.style.display = "block";
      return;
    }

    if (body.requires_totp) {
      pendingToken = body.pending_token;
      document.getElementById("login-form").style.display = "none";
      document.getElementById("totp-form").style.display = "block";
      document.getElementById("totp-code").focus();
      return;
    }

    window.location.href = "/";
  } catch {
    errorEl.textContent = "Could not reach the server.";
    errorEl.style.display = "block";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Sign in";
  }
});

document.getElementById("totp-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("totp-error");
  const submitBtn = document.getElementById("totp-submit-btn");
  errorEl.style.display = "none";
  submitBtn.disabled = true;

  try {
    const res = await fetch("/api/auth/verify-totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pending_token: pendingToken,
        code: document.getElementById("totp-code").value.trim(),
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      errorEl.textContent = body.detail || "Verification failed.";
      errorEl.style.display = "block";
      return;
    }

    window.location.href = "/";
  } catch {
    errorEl.textContent = "Could not reach the server.";
    errorEl.style.display = "block";
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("totp-back-btn").addEventListener("click", () => {
  pendingToken = null;
  document.getElementById("totp-form").style.display = "none";
  document.getElementById("login-form").style.display = "block";
  document.getElementById("password").value = "";
});
