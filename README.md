# Ops Dashboard

A small, standalone portal with login and four pages, each its own real URL (so bookmarking,
refreshing, and linking directly to a section all just work):
- **PDF Reports** (`/`) -- each lender is a small window-styled card (title bar, minimize/
  maximize/close glyphs, purely decorative) listing its report periods and files, with a lender
  filter dropdown above covering the full lender list (see below). Click View to open a PDF in
  a new tab or Download to save it. Read-only: it does **not** generate, download, or
  regenerate anything.
- **Analytics** (`/analytics`) -- pick a query from the catalog (11 of them, ported from
  `jifiti_useful_queries.sql`: daily volume, stuck applications, failure rates, lender
  performance, month-over-month growth, top merchants, application/customer/merchant
  lookups by ID), fill in that query's own inputs (merchant, lender, application ID, date
  range, thresholds -- whatever it needs), run it, and get both a table and a chart. If the
  DB isn't configured, this page shows a message instead of failing -- PDF Reports is
  unaffected either way.
- **FullStory** (`/fullstory`) -- paste one or more ApplicationIDs (or upload a .json/.txt list)
  and it records each one's FullStory sessions from the last 90 days to video, as a single batch
  job (see below).
- **Admin** (`/admin`, admin role only) -- create teammate accounts and choose exactly which
  lender PDF folders and which analytics merchants/lenders each teammate can see. A brand-new
  account starts with **zero** access until an admin grants some -- access is opt-in.
- **Security** (`/security`) -- every account can turn on two-factor auth here (see below).

Nobody can use this until you create their account -- there's no self-signup.

## Two-factor authentication

Any account -- including yours -- can enable TOTP-based 2FA (Google Authenticator, Authy,
1Password, etc.) from the **Security** page: scan the QR code, enter the 6-digit code once to
confirm you actually set it up correctly, and it's on. From then on, signing in needs the
password *and* a current code.

Lost access to the authenticator? An admin can force-disable 2FA for any account from the
**Admin** page ("Reset 2FA" button next to a user whose 2FA is on) -- they can re-enroll from
their own Security page afterward. This needs `pyotp` and `qrcode[pil]`, both already in
`requirements.txt`.

## FullStory session recording

The **FullStory** page runs the Playwright/Node automation that used to be its own standalone
project (`automation/fullstory/`) -- it's launched as a subprocess per ApplicationID rather than
ported to Python, since it drives a real, visible Chrome window against `app.fullstory.com`.

- Only **one recording job runs at a time**, since it's one shared login session and one visible
  browser on this machine -- starting a second job while one is running returns a 409 until the
  first finishes.
- Needs **Node.js** on PATH (dependencies and browser binaries are already installed under
  `automation/fullstory/node_modules`).
- Needs a saved FullStory login session at `automation/fullstory/playwright/.auth/user.json`.
  If it's missing or has expired, run this once and log in manually when the browser opens:
  ```powershell
  cd automation\fullstory
  node authenticate.js
  ```
- Needs `automation/fullstory/.env` configured (`FULLSTORY_ORG_ID`, `OUTPUT_DIR`, etc. -- see
  `automation/fullstory/.env.example`). Videos are saved under `OUTPUT_DIR`, not served by the
  dashboard itself.
- Both `.env` and the saved login session hold real credentials -- they're gitignored, same as
  the dashboard's own `.env`.

## Lenders

The PDF-access grant list (in Admin) covers the full business lender list, not just folders
that already exist, so you can grant a lender before its first report lands:

Citizens, FECI, Floa, Huntington, Ikano / Nets, JDF, RBC, Seattle Bank, IKEA IE, AGOS, CACF,
Caixa Bank, Barclays, BuyWay

A few of these have on-disk folder names that don't match the business name exactly (e.g.
"Caixa Bank" -> `CAIXA`, "Ikano / Nets" -> `IKANO`) -- see `app/lenders.py` for the mapping if
you add another lender whose folder name doesn't match its business name 1:1.

Expected folder layout (matches the existing report generator's output):

```
<REPORTS_ROOT_DIR>/
  FECI/
    2025-07/
      07_FECI_Monthly_Report.pdf
  AGOS/
    2025-07/
      07_AGOS_Monthly_Report.pdf
  ...
```

## Setup (PowerShell)

If your machine's execution policy blocks `.venv\Scripts\activate.ps1` (common on locked-down
corporate Windows), skip activation entirely and call the venv's `python.exe` directly by path
-- that's a plain executable, not a script, so the policy doesn't apply to it:

```powershell
cd C:\Users\noor.m\Desktop\dashboard
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env
```

Edit `.env` and set `REPORTS_ROOT_DIR` to the real folder where your generated PDFs live
(the `output_dir` from your existing `multi_lender_config.ini`).

### Analytics DB (optional)

The US and EU ConsumerFinancing replicas are separate SQL Server databases with disjoint
lenders/merchants/applications, so this app connects to each independently -- the Analytics
page has a region toggle that picks which one a query runs against. RBC is a third, dedicated
server: RBC's US business runs on its own database rather than the shared US replica, and RBC
data lives only there, so it gets its own region entry too. Configure any subset of the three
in `.env`; a region you leave unconfigured just shows as unavailable in the toggle instead of
erroring.

If your DB host uses **Windows Authentication** (the common case for an internal SQL Server)
-- which this app now defaults to -- no SQL login/password is needed at all; it connects as
whichever Windows account runs the process:

```
US_ANALYTICS_DB_HOST=your-us-replica-host
US_ANALYTICS_DB_NAME=ConsumerFinancing_Replica_US
US_ANALYTICS_DB_TRUSTED_CONNECTION=true
US_ANALYTICS_DB_DRIVER=ODBC Driver 18 for SQL Server

EU_ANALYTICS_DB_HOST=your-eu-replica-host
EU_ANALYTICS_DB_NAME=ConsumerFinancing_Replica_EU
EU_ANALYTICS_DB_TRUSTED_CONNECTION=true
EU_ANALYTICS_DB_DRIVER=ODBC Driver 18 for SQL Server

RBC_ANALYTICS_DB_HOST=your-rbc-server-host
RBC_ANALYTICS_DB_NAME=ConsumerFinancing_Replica_RBC
RBC_ANALYTICS_DB_TRUSTED_CONNECTION=true
RBC_ANALYTICS_DB_DRIVER=ODBC Driver 18 for SQL Server
```

If instead a host uses SQL Server authentication (a login + password), set that region's
`_TRUSTED_CONNECTION=false` and fill in its `_USER` / `_PASSWORD` -- use a **read-only** login
there, since this app only ever runs `SELECT` queries, but the login itself should enforce
that too, as a second layer of protection.

If Windows Auth is on and a region's connection fails with a SQL Server login error (not a
"not configured" message), that means the Windows account running this app doesn't have
access granted on that particular host -- each of the three servers needs the account added
separately, since access on one doesn't imply access on another.

Check which ODBC driver is actually installed on your machine first -- 17 and 18 are not
interchangeable, and using the wrong name will fail to connect:

```powershell
.venv\Scripts\python.exe -c "import pyodbc; print(pyodbc.drivers())"
```

Leave all three `*_ANALYTICS_DB_HOST` blank and the Analytics tab just shows "not configured"
instead of erroring -- the PDF viewer is unaffected either way.

**Note on Windows Auth if you ever run this as a service:** the identity that matters is
whichever Windows account the Python process itself runs as -- if that's your own interactive
login, it just works as long as your account has SQL Server access; if this later runs under
a Windows service account instead, *that* account needs the SQL Server grant, not yours.

### Login sessions (required before anyone but you uses this)

Generate a real secret and put it in `.env`:

```powershell
.venv\Scripts\python.exe -c "import secrets; print(secrets.token_hex(32))"
```

```
SESSION_SECRET_KEY=<paste the generated value>
```

Without this, the app runs on an insecure hardcoded default and logs a warning on startup --
fine for a five-minute local test, not once teammates are actually logging in, since anyone
who saw that default could forge a session cookie.

### Create the first admin account

```powershell
.venv\Scripts\python.exe -m scripts.create_admin you@jifiti.com
```

It prompts for a password (never pass it as a command-line argument). Once you're logged in
as admin, create every other teammate's account from the **Admin** page in the app -- there's
no self-signup by design.

## Run

```powershell
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000, sign in, pick a lender/period in the sidebar to view the PDF, or
click Download. As admin, use the **Admin** tab to add teammates and grant each one exactly
the lenders/merchants they should see.

### Sharing this with teammates on your network

Running on `127.0.0.1` only accepts connections from this machine. To let teammates reach it
from their own computers, set `HOST=0.0.0.0` in `.env` and run it on your machine's actual
network address -- but do that **only** on a trusted internal network, and set
`SESSION_COOKIE_SECURE=true` plus put it behind HTTPS (e.g. a reverse proxy) before exposing
it beyond localhost, since login currently happens over plain HTTP otherwise.

(If you'd rather activate the venv normally in the future, an admin can allow it for your
user with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` -- that's a security-policy
change though, so only do it if you want activation available generally, not just for this.)

## Already have this running?

If you started the server earlier, run `pip install -r requirements.txt` again (2FA added
two new dependencies) and restart it. If you're running with `--reload`, the code picks up
automatically -- but the *new dependencies* still need installing first, or the reload will
crash on import.

Your existing `app_data.db` predates the 2FA columns -- that's handled automatically. On
startup the app checks for columns a newer version of the code added that an existing
database doesn't have yet, and adds them in place (see `app/db.py`) -- no data is lost, no
manual migration step needed.

## Known caveat

`app/analytics_queries.py`'s "stuck applications" query excludes a hardcoded list of
statuses (`DEFAULT_TERMINAL_STATUSES`) that were carried over from the original monitoring
query -- that list reads as terminal-looking statuses inside a "stuck in non-terminal
status" check, which looked inverted. Worth confirming against the real `ApplicationStatus`
enum before trusting the stuck-applications count for anything beyond a rough first pass.
