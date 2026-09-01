"""In-process TTL cache for analytics query results.

Hitting the SQL Server replica on every "Run Query" click is what makes the Analytics page
feel slow. Wrapping each query function in `analytics_queries.py` with `@cached(ttl=...)`
means repeated requests for the same query + params (from the same user or a different one)
are served from memory instead of round-tripping to the DB. `warm_startup()` additionally
pre-runs the parameterless / rarely-changing queries (merchant list, lender list, top
merchants) once at app startup in a background thread, so those are already warm before the
first real request -- see the call in `app/main.py`'s lifespan.
"""

import functools
import logging
import threading
import time
from typing import Callable

logger = logging.getLogger(__name__)

_DEFAULT_TTL_SECONDS = 300.0

_lock = threading.Lock()
_cache: dict[str, tuple[float, list[dict]]] = {}


def _make_key(fn_name: str, args: tuple, kwargs: dict) -> str:
    return f"{fn_name}:{args!r}:{sorted(kwargs.items())!r}"


def cached(ttl: float = _DEFAULT_TTL_SECONDS):
    """Decorator for a function returning `list[dict]`. Caches by (function name, args,
    kwargs) for `ttl` seconds. Safe to share across users: query functions in
    analytics_queries.py take explicit params (merchant_id, date range, ...) rather than a
    user object, so the cached rows are identical for anyone permitted to run that query --
    access control and per-row filtering happen separately, after this returns."""

    def decorator(fn: Callable[..., list[dict]]) -> Callable[..., list[dict]]:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            key = _make_key(fn.__name__, args, kwargs)
            now = time.monotonic()
            with _lock:
                hit = _cache.get(key)
                if hit is not None and now - hit[0] < ttl:
                    return hit[1]
            rows = fn(*args, **kwargs)
            with _lock:
                _cache[key] = (now, rows)
            return rows

        wrapper.__wrapped__ = fn
        return wrapper

    return decorator


def invalidate_all() -> None:
    with _lock:
        _cache.clear()


def warm_startup(warmers: list[tuple[str, Callable[[], object]]]) -> None:
    """Run each warmer eagerly, in a background thread, so the cache is already populated by
    the time the first user opens the Analytics page. Failures (e.g. DB not configured, or
    not reachable yet) are logged and skipped -- this must never block or crash app startup."""

    def _run():
        for name, fn in warmers:
            try:
                fn()
                logger.info("Analytics cache warm: %s ready", name)
            except Exception:
                logger.warning("Analytics cache warm: %s failed (will run on first request)", name, exc_info=True)

    threading.Thread(target=_run, name="analytics-cache-warm", daemon=True).start()
