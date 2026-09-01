import logging
from typing import Iterator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app import config

logger = logging.getLogger(__name__)

engine = create_engine(config.APP_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Columns added to a model *after* an app_data.db already existed on disk. create_all() only
# creates missing tables, never adds columns to a table that's already there -- there's no
# migration framework in this small app, so new nullable/defaulted columns get added here by
# hand instead. Each entry: (table, column, SQLite column DDL).
_COLUMN_MIGRATIONS = [
    ("users", "totp_secret", "VARCHAR(64)"),
    ("users", "totp_enabled", "BOOLEAN DEFAULT 0"),
]


def _run_column_migrations() -> None:
    inspector = inspect(engine)
    if "users" not in inspector.get_table_names():
        return  # fresh DB -- create_all() above already created the table with every column

    existing_columns = {col["name"] for col in inspector.get_columns("users")}
    with engine.begin() as conn:
        for table, column, ddl in _COLUMN_MIGRATIONS:
            if column in existing_columns:
                continue
            logger.warning(f"Migrating: adding column {table}.{column} to existing database")
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))


def init_db() -> None:
    from app import models  # noqa: F401 -- register models on Base.metadata

    Base.metadata.create_all(bind=engine)
    _run_column_migrations()
