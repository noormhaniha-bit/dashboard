import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

_raw_root = os.getenv("REPORTS_ROOT_DIR", "").strip()
# Deliberately None rather than Path("") when unset -- Path("") stringifies to "." (the
# current working directory), which exists and is truthy, so an empty env var would
# otherwise silently fall through as "configured" and serve files from wherever the
# process happens to be run from.
REPORTS_ROOT_DIR: Path | None = Path(_raw_root).expanduser() if _raw_root else None

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))

# --- Read-only analytics connection (ConsumerFinancing replica) ---
ANALYTICS_DB_HOST = os.getenv("ANALYTICS_DB_HOST", "").strip()
ANALYTICS_DB_PORT = int(os.getenv("ANALYTICS_DB_PORT", "1433"))
ANALYTICS_DB_NAME = os.getenv("ANALYTICS_DB_NAME", "").strip()
ANALYTICS_DB_USER = os.getenv("ANALYTICS_DB_USER", "").strip()
ANALYTICS_DB_PASSWORD = os.getenv("ANALYTICS_DB_PASSWORD", "").strip()
ANALYTICS_DB_DRIVER = os.getenv("ANALYTICS_DB_DRIVER", "ODBC Driver 18 for SQL Server").strip()

# Windows Authentication (Trusted_Connection) -- the SQL login is whatever Windows identity
# this process runs as, so ANALYTICS_DB_USER/PASSWORD are ignored and not required when
# this is on. If the app later runs as a Windows service under a different account, that
# account (not your own login) needs SQL Server access.
ANALYTICS_DB_TRUSTED_CONNECTION = os.getenv("ANALYTICS_DB_TRUSTED_CONNECTION", "false").strip().lower() == "true"

ANALYTICS_DB_CONFIGURED = bool(
    ANALYTICS_DB_HOST and ANALYTICS_DB_NAME and (ANALYTICS_DB_TRUSTED_CONNECTION or ANALYTICS_DB_USER)
)


def analytics_sqlalchemy_url() -> str:
    from urllib.parse import quote_plus

    if ANALYTICS_DB_TRUSTED_CONNECTION:
        odbc_str = (
            f"DRIVER={{{ANALYTICS_DB_DRIVER}}};"
            f"SERVER={ANALYTICS_DB_HOST},{ANALYTICS_DB_PORT};"
            f"DATABASE={ANALYTICS_DB_NAME};"
            "Trusted_Connection=yes;"
            "TrustServerCertificate=yes;"
        )
        return f"mssql+pyodbc:///?odbc_connect={quote_plus(odbc_str)}"

    driver = quote_plus(ANALYTICS_DB_DRIVER)
    password = quote_plus(ANALYTICS_DB_PASSWORD)
    return (
        f"mssql+pyodbc://{ANALYTICS_DB_USER}:{password}"
        f"@{ANALYTICS_DB_HOST}:{ANALYTICS_DB_PORT}/{ANALYTICS_DB_NAME}"
        f"?driver={driver}&TrustServerCertificate=yes"
    )


# --- FullStory session-recording automation (Playwright/Node, launched as a subprocess) ---
FULLSTORY_AUTOMATION_DIR = Path(__file__).resolve().parents[1] / "automation" / "fullstory"
FULLSTORY_NODE_BIN = os.getenv("FULLSTORY_NODE_BIN", "").strip() or "node"

# --- App database (users, access grants) -- local SQLite file, not the analytics replica ---
APP_DATABASE_PATH = Path(__file__).resolve().parents[1] / "app_data.db"
APP_DATABASE_URL = f"sqlite:///{APP_DATABASE_PATH}"

# --- Sessions (signed cookie, not stored server-side) ---
_default_secret = "dev-only-insecure-secret-change-me"
SESSION_SECRET_KEY = os.getenv("SESSION_SECRET_KEY", "").strip() or _default_secret
if SESSION_SECRET_KEY == _default_secret:
    import logging

    logging.getLogger(__name__).warning(
        "SESSION_SECRET_KEY is not set -- using an insecure default. Set a random value in "
        ".env before exposing this app beyond your own machine, or every session cookie can "
        "be forged."
    )

SESSION_COOKIE_NAME = "sla_dashboard_session"
SESSION_MAX_AGE_SECONDS = int(os.getenv("SESSION_MAX_AGE_HOURS", "12")) * 3600
# Only send the cookie over HTTPS -- set to true once this runs behind TLS (e.g. a reverse
# proxy), not on localhost/plain HTTP.
SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "false").strip().lower() == "true"
