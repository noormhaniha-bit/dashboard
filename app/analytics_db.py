"""Read-only connection to the ConsumerFinancing analytics replica. Kept separate from the
PDF-browsing part of this app -- nothing here writes to the database or executes anything
beyond the SELECT queries in analytics_queries.py.
"""

import logging
from typing import Any

from sqlalchemy import bindparam, create_engine, text

from app import config

logger = logging.getLogger(__name__)


class AnalyticsNotConfigured(Exception):
    pass


_engine = None


def get_engine():
    global _engine
    if not config.ANALYTICS_DB_CONFIGURED:
        raise AnalyticsNotConfigured(
            "ANALYTICS_DB_HOST/ANALYTICS_DB_NAME/ANALYTICS_DB_USER are not set in .env."
        )
    if _engine is None:
        _engine = create_engine(config.analytics_sqlalchemy_url(), pool_pre_ping=True)
    return _engine


def run_query(sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    params = params or {}
    engine = get_engine()

    # A list/tuple-valued param (e.g. "status NOT IN :excluded_statuses") needs an explicit
    # expanding bindparam -- without it, text() hands pyodbc the tuple as-is, which the SQL
    # Server driver reads as a table-valued parameter and rejects ("A TVP's rows must all be
    # the same size"), not as an IN (...) list.
    stmt = text(sql)
    expanding = [name for name, value in params.items() if isinstance(value, (list, tuple))]
    if expanding:
        stmt = stmt.bindparams(*(bindparam(name, expanding=True) for name in expanding))

    with engine.connect() as conn:
        result = conn.execute(stmt, params)
        return [dict(row) for row in result.mappings()]
