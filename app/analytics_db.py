"""Read-only connections to the ConsumerFinancing analytics replicas -- one per region (US,
EU), each a wholly separate SQL Server database. Kept separate from the PDF-browsing part of
this app -- nothing here writes to the database or executes anything beyond the SELECT
queries in analytics_queries.py.
"""

import logging
from typing import Any

from sqlalchemy import bindparam, create_engine, text
from sqlalchemy.exc import DBAPIError

from app import config

logger = logging.getLogger(__name__)


class AnalyticsNotConfigured(Exception):
    pass


class AnalyticsConnectionFailed(Exception):
    """The region's host/name/user are set, but the DB itself rejected or couldn't complete
    the connection (bad login, network unreachable, etc.) -- distinct from AnalyticsNotConfigured
    (nothing was even attempted because .env is missing values), so callers can tell "not set
    up yet" apart from "set up but broken" and the API can still fail cleanly (503, not a raw
    500 traceback) instead of leaking a driver-level stack trace to the browser."""


_engines: dict[str, Any] = {}


def get_engine(region: str):
    if region not in config.ANALYTICS_DBS:
        raise ValueError(f"Unknown analytics region: {region!r} (expected one of {config.REGIONS})")
    cfg = config.ANALYTICS_DBS[region]
    if not cfg.configured:
        raise AnalyticsNotConfigured(
            f"{region}_ANALYTICS_DB_HOST/{region}_ANALYTICS_DB_NAME/{region}_ANALYTICS_DB_USER "
            "are not set in .env."
        )
    if region not in _engines:
        _engines[region] = create_engine(cfg.sqlalchemy_url(), pool_pre_ping=True)
    return _engines[region]


def run_query(sql: str, params: dict[str, Any] | None = None, *, region: str) -> list[dict[str, Any]]:
    params = params or {}
    engine = get_engine(region)

    # A list/tuple-valued param (e.g. "status NOT IN :excluded_statuses") needs an explicit
    # expanding bindparam -- without it, text() hands pyodbc the tuple as-is, which the SQL
    # Server driver reads as a table-valued parameter and rejects ("A TVP's rows must all be
    # the same size"), not as an IN (...) list.
    stmt = text(sql)
    expanding = [name for name, value in params.items() if isinstance(value, (list, tuple))]
    if expanding:
        stmt = stmt.bindparams(*(bindparam(name, expanding=True) for name in expanding))

    try:
        with engine.connect() as conn:
            result = conn.execute(stmt, params)
            return [dict(row) for row in result.mappings()]
    except DBAPIError as e:
        # Login failures, an unreachable host, a driver mismatch, etc. -- the config is
        # present (get_engine already checked that) but the DB itself couldn't be used. Log
        # the full driver error for whoever has to fix the DB side; the caller only needs to
        # know which region broke, not the raw pyodbc/ODBC message.
        logger.error("%s analytics DB query failed: %s", region, e, exc_info=True)
        raise AnalyticsConnectionFailed(
            f"The {region} analytics database is configured but the connection failed -- check "
            f"that the {region}_ANALYTICS_DB_* settings are correct and the account running this "
            "app has access. See the server log for the underlying driver error."
        ) from e
