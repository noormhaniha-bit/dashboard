import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote_plus

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

# --- Read-only analytics connections -- US and EU are separate SQL Server databases (the
# ConsumerFinancing platform runs one replica per region), so lenders/merchants/applications
# in one are entirely disjoint from the other. RBC is a third, dedicated server: RBC's US
# business runs on its own database rather than the shared US replica, and RBC data exists
# only there -- the shared US replica has none of it. Every analytics query is scoped to
# exactly one of these at a time -- see app/analytics_db.py and app/analytics_queries.py.
REGIONS = ["US", "EU", "RBC"]


@dataclass(frozen=True)
class AnalyticsDbConfig:
    region: str
    host: str
    port: int
    name: str
    user: str
    password: str
    driver: str
    trusted_connection: bool

    @property
    def configured(self) -> bool:
        return bool(self.host and self.name and (self.trusted_connection or self.user))

    def sqlalchemy_url(self) -> str:
        if self.trusted_connection:
            odbc_str = (
                f"DRIVER={{{self.driver}}};"
                f"SERVER={self.host},{self.port};"
                f"DATABASE={self.name};"
                "Trusted_Connection=yes;"
                "TrustServerCertificate=yes;"
            )
            return f"mssql+pyodbc:///?odbc_connect={quote_plus(odbc_str)}"

        driver = quote_plus(self.driver)
        password = quote_plus(self.password)
        return (
            f"mssql+pyodbc://{self.user}:{password}"
            f"@{self.host}:{self.port}/{self.name}"
            f"?driver={driver}&TrustServerCertificate=yes"
        )


def _load_analytics_db_config(region: str) -> AnalyticsDbConfig:
    prefix = f"{region}_ANALYTICS_DB_"
    return AnalyticsDbConfig(
        region=region,
        host=os.getenv(f"{prefix}HOST", "").strip(),
        port=int(os.getenv(f"{prefix}PORT", "1433")),
        name=os.getenv(f"{prefix}NAME", "").strip(),
        user=os.getenv(f"{prefix}USER", "").strip(),
        password=os.getenv(f"{prefix}PASSWORD", "").strip(),
        driver=os.getenv(f"{prefix}DRIVER", "ODBC Driver 18 for SQL Server").strip(),
        # Windows Authentication (Trusted_Connection) -- the SQL login is whatever Windows
        # identity this process runs as, so USER/PASSWORD are ignored and not required when
        # this is on. If the app later runs as a Windows service under a different account,
        # that account (not your own login) needs SQL Server access.
        trusted_connection=os.getenv(f"{prefix}TRUSTED_CONNECTION", "false").strip().lower() == "true",
    )


ANALYTICS_DBS: dict[str, AnalyticsDbConfig] = {region: _load_analytics_db_config(region) for region in REGIONS}
ANY_ANALYTICS_DB_CONFIGURED = any(cfg.configured for cfg in ANALYTICS_DBS.values())


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
