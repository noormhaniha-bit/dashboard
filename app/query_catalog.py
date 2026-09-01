"""Catalog of runnable analytics queries. Each entry declares its own input parameters and
a chart hint, so the frontend can render a query picker -> per-query input form -> table +
chart generically, without one-off UI code per query.

Every runner takes `region` ("US" or "EU") as call context, the same way it takes `user` and
`db` -- the page-level region toggle picks it, not a per-query form field, since it applies to
every query the same way. Every runner enforces access itself (rather than a generic wrapper
in main.py) because the right check differs by query shape:
  - queries keyed directly by merchant_id/lender_id check that key against the user's grants
    before running
  - queries keyed by an arbitrary id (application_id, a customer search term) can't be
    checked up front -- they run first, then the result rows are post-filtered by the
    merchant_id embedded in each row, so a member can't fish for another merchant's data
    by guessing IDs
"""

from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app import access, analytics_queries
from app.models import User


@dataclass
class QueryParam:
    name: str
    type: str  # "merchant_select" | "lender_select" | "text" | "date" | "number"
    label: str
    required: bool = True
    default: Any = None


@dataclass
class QuerySpec:
    id: str
    label: str
    category: str
    description: str
    params: list[QueryParam]
    chart: dict | None
    runner: Callable[[dict, User, Session, str], list[dict]] = field(repr=False)


def _require(allowed: set[str] | None, key: str, what: str) -> None:
    if not access.can_access(allowed, key):
        raise HTTPException(status_code=403, detail=f"You don't have access to this {what}.")


def _filter_by_merchant(rows: list[dict], allowed: set[str] | None) -> list[dict]:
    if allowed is None:
        return rows
    return [r for r in rows if r.get("merchant_id") in allowed]


# --- runners ---------------------------------------------------------------


def _run_daily_volume(p, user, db, region):
    _require(access.allowed_analytics_merchants(db, user, region), p["merchant_id"], "merchant")
    return analytics_queries.get_daily_application_volume(region, p["merchant_id"], p["date_from"], p["date_to"])


def _run_stuck_applications(p, user, db, region):
    _require(access.allowed_analytics_merchants(db, user, region), p["merchant_id"], "merchant")
    return analytics_queries.get_stuck_applications(
        region, p["merchant_id"], analytics_queries.DEFAULT_TERMINAL_STATUSES, float(p["threshold_hours"])
    )


def _run_failure_rate(p, user, db, region):
    _require(access.allowed_analytics_merchants(db, user, region), p["merchant_id"], "merchant")
    return analytics_queries.get_transaction_failure_rate_by_hour(region, p["merchant_id"], int(p["hours"]))


def _run_failures_by_status(p, user, db, region):
    _require(access.allowed_analytics_merchants(db, user, region), p["merchant_id"], "merchant")
    return analytics_queries.get_transaction_failures_by_status(region, p["merchant_id"], int(p["hours"]))


def _run_lender_performance(p, user, db, region):
    _require(access.allowed_analytics_lenders(db, user, region), p["lender_id"], "lender")
    return analytics_queries.get_lender_performance(region, p["lender_id"], p["date_from"], p["date_to"])


def _run_merchants_by_lender(p, user, db, region):
    _require(access.allowed_analytics_lenders(db, user, region), p["lender_id"], "lender")
    return analytics_queries.get_merchants_by_lender(region, p["lender_id"])


def _run_monthly_growth(p, user, db, region):
    _require(access.allowed_analytics_merchants(db, user, region), p["merchant_id"], "merchant")
    return analytics_queries.get_monthly_growth(region, p["merchant_id"], int(p["months"]))


def _run_daily_activity_week(p, user, db, region):
    _require(access.allowed_analytics_merchants(db, user, region), p["merchant_id"], "merchant")
    return analytics_queries.get_daily_activity_by_week(region, p["merchant_id"], int(p["days"]))


def _run_applications_by_weekday(p, user, db, region):
    _require(access.allowed_analytics_merchants(db, user, region), p["merchant_id"], "merchant")
    return analytics_queries.get_applications_by_weekday(region, p["merchant_id"], p["date_from"], p["date_to"])


def _run_top_merchants(p, user, db, region):
    rows = analytics_queries.get_top_merchants_last_month(region)
    return _filter_by_merchant(rows, access.allowed_analytics_merchants(db, user, region))


def _run_stuck_applications_overview(p, user, db, region):
    rows = analytics_queries.get_stuck_applications_overview(
        region, analytics_queries.DEFAULT_TERMINAL_STATUSES, float(p["threshold_hours"])
    )
    return _filter_by_merchant(rows, access.allowed_analytics_merchants(db, user, region))


def _run_application_lookup(p, user, db, region):
    rows = analytics_queries.get_application_by_id(region, p["application_id"])
    return _filter_by_merchant(rows, access.allowed_analytics_merchants(db, user, region))


def _run_application_transactions(p, user, db, region):
    rows = analytics_queries.get_transactions_by_application(region, p["application_id"])
    return _filter_by_merchant(rows, access.allowed_analytics_merchants(db, user, region))


def _run_customer_search(p, user, db, region):
    rows = analytics_queries.search_customers(region, p["search_term"])
    return _filter_by_merchant(rows, access.allowed_analytics_merchants(db, user, region))


# --- catalog ----------------------------------------------------------------

QUERY_CATALOG: list[QuerySpec] = [
    QuerySpec(
        id="daily_volume",
        label="Daily application volume",
        category="Business reporting",
        description="Applications per day for one merchant, with approval/decline counts.",
        params=[
            QueryParam("lender_id", "lender_select", "Lender"),
            QueryParam("merchant_id", "merchant_select", "Merchant"),
            QueryParam("date_from", "date", "From"),
            QueryParam("date_to", "date", "To"),
        ],
        chart={"kind": "xy", "type": "bar", "x": "application_date", "y": ["approved_count", "declined_count"]},
        runner=_run_daily_volume,
    ),
    QuerySpec(
        id="stuck_applications",
        label="Stuck applications",
        category="Monitoring",
        description="Applications open longer than a threshold, excluding terminal statuses.",
        params=[
            QueryParam("lender_id", "lender_select", "Lender"),
            QueryParam("merchant_id", "merchant_select", "Merchant"),
            QueryParam("threshold_hours", "number", "Stuck threshold (hrs)", required=False, default=4),
        ],
        chart={"kind": "count_by", "type": "bar", "x": "application_status"},
        runner=_run_stuck_applications,
    ),
    QuerySpec(
        id="failure_rate",
        label="Transaction failure rate (hourly)",
        category="Monitoring",
        description="Hourly transaction volume and failure rate trend for one merchant.",
        params=[
            QueryParam("lender_id", "lender_select", "Lender"),
            QueryParam("merchant_id", "merchant_select", "Merchant"),
            QueryParam("hours", "number", "Window (hrs)", required=False, default=48),
        ],
        chart={"kind": "xy", "type": "line", "x": "hour_bucket_utc", "y": ["failure_rate"]},
        runner=_run_failure_rate,
    ),
    QuerySpec(
        id="failures_by_status",
        label="Failed transactions by status",
        category="Monitoring",
        description="Failed/errored transaction counts grouped by status, last N hours.",
        params=[
            QueryParam("lender_id", "lender_select", "Lender"),
            QueryParam("merchant_id", "merchant_select", "Merchant"),
            QueryParam("hours", "number", "Window (hrs)", required=False, default=24),
        ],
        chart={"kind": "xy", "type": "bar", "x": "status", "y": ["failed_count"]},
        runner=_run_failures_by_status,
    ),
    QuerySpec(
        id="lender_performance",
        label="Lender performance",
        category="Business reporting",
        description="Approval rate and average funded amount for one lender, over a date range.",
        params=[
            QueryParam("lender_id", "lender_select", "Lender"),
            QueryParam("date_from", "date", "From"),
            QueryParam("date_to", "date", "To"),
        ],
        chart={"kind": "xy", "type": "bar", "x": None, "y": ["total_applications", "approved_count"]},
        runner=_run_lender_performance,
    ),
    QuerySpec(
        id="monthly_growth",
        label="Month-over-month growth",
        category="Business reporting",
        description="Monthly originated volume and growth rate for one merchant.",
        params=[
            QueryParam("lender_id", "lender_select", "Lender"),
            QueryParam("merchant_id", "merchant_select", "Merchant"),
            QueryParam("months", "number", "Months back", required=False, default=13),
        ],
        chart={"kind": "xy", "type": "line", "x": "month_start", "y": ["total_requested"]},
        runner=_run_monthly_growth,
    ),
    QuerySpec(
        id="daily_activity_week",
        label="Daily activity (last 7 days)",
        category="Monitoring",
        description="Day-by-day (not hourly) transaction volume and failure rate for one merchant, over the last week.",
        params=[
            QueryParam("lender_id", "lender_select", "Lender"),
            QueryParam("merchant_id", "merchant_select", "Merchant"),
            QueryParam("days", "number", "Days back", required=False, default=7),
        ],
        chart={"kind": "xy", "type": "bar", "x": "activity_date", "y": ["total_transactions", "failed_transactions"]},
        runner=_run_daily_activity_week,
    ),
    QuerySpec(
        id="applications_by_weekday",
        label="Applications by day of week",
        category="Business reporting",
        description="Application volume and approvals grouped by weekday, over a date range, for one merchant.",
        params=[
            QueryParam("lender_id", "lender_select", "Lender"),
            QueryParam("merchant_id", "merchant_select", "Merchant"),
            QueryParam("date_from", "date", "From"),
            QueryParam("date_to", "date", "To"),
        ],
        chart={"kind": "xy", "type": "bar", "x": "weekday_name", "y": ["total_applications", "approved_count"]},
        runner=_run_applications_by_weekday,
    ),
    QuerySpec(
        id="top_merchants",
        label="Top merchants (last month)",
        category="Business reporting",
        description="Top merchants by originated volume, last full calendar month. Shows only merchants you have access to.",
        params=[],
        chart={"kind": "xy", "type": "bar", "x": "merchant_name", "y": ["total_requested_amount"]},
        runner=_run_top_merchants,
    ),
    QuerySpec(
        id="stuck_applications_overview",
        label="Stuck applications (all merchants)",
        category="Monitoring",
        description="Applications open longer than a threshold, across every merchant you have access to.",
        params=[QueryParam("threshold_hours", "number", "Stuck threshold (hrs)", required=False, default=4)],
        chart={"kind": "count_by", "type": "bar", "x": "merchant_name"},
        runner=_run_stuck_applications_overview,
    ),
    QuerySpec(
        id="merchants_by_lender",
        label="Merchants under a lender",
        category="Lookups",
        description="All merchants tied to a given lender.",
        params=[QueryParam("lender_id", "lender_select", "Lender")],
        chart=None,
        runner=_run_merchants_by_lender,
    ),
    QuerySpec(
        id="application_lookup",
        label="Application lookup",
        category="Lookups",
        description="A single application by ID, with merchant/lender/customer context.",
        params=[QueryParam("application_id", "text", "Application ID")],
        chart=None,
        runner=_run_application_lookup,
    ),
    QuerySpec(
        id="application_transactions",
        label="Transactions for an application",
        category="Lookups",
        description="Payment history (charges, refunds, adjustments) for one application.",
        params=[QueryParam("application_id", "text", "Application ID")],
        chart={"kind": "xy", "type": "bar", "x": "date_created", "y": ["amount"]},
        runner=_run_application_transactions,
    ),
    QuerySpec(
        id="customer_search",
        label="Customer lookup",
        category="Lookups",
        description="Customer + application history by email or phone number.",
        params=[QueryParam("search_term", "text", "Email or phone")],
        chart={"kind": "count_by", "type": "bar", "x": "application_status"},
        runner=_run_customer_search,
    ),
]

QUERY_REGISTRY: dict[str, QuerySpec] = {q.id: q for q in QUERY_CATALOG}
