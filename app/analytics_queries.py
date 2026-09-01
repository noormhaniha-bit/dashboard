"""Parameterized read-only queries against the ConsumerFinancing analytics replicas, ported
from jifiti_useful_queries.sql. All filters are bound parameters -- nothing here builds SQL
by string concatenation.

Every function takes `region` ("US" or "EU") as its first argument and forwards it to
run_query, which picks the matching database connection -- the US and EU replicas are
wholly separate databases, so a query never spans both.

NOTE: `get_stuck_applications` takes `excluded_statuses` explicitly rather than hardcoding
them, because the original query's status list reads as terminal-looking statuses inside a
"stuck in non-terminal status" check -- confirm the real ApplicationStatus enum before
trusting this for anything beyond a rough first pass.
"""

from datetime import date

from app.analytics_cache import cached
from app.analytics_db import run_query

DEFAULT_TERMINAL_STATUSES = [
    "Canceled", "Approved", "Reversed", "Expired", "Validated",
    "DummyApplication", "Unknown", "Refunded", "Abandoned", "Error",
    "Declined", "Accepted",
]


@cached(ttl=600)
def list_merchants(region: str, limit: int = 500) -> list[dict]:
    sql = "SELECT TOP (:limit) Id AS merchant_id, Name AS merchant_name FROM Merchants WHERE IsDeleted = 0 ORDER BY Name"
    return run_query(sql, {"limit": limit}, region=region)


@cached(ttl=600)
def list_lenders(region: str, limit: int = 500) -> list[dict]:
    sql = "SELECT TOP (:limit) Id AS lender_id, Name AS lender_name FROM Lenders ORDER BY Name"
    return run_query(sql, {"limit": limit}, region=region)


@cached(ttl=600)
def list_merchants_with_lender(region: str, limit: int = 500) -> list[dict]:
    """Like list_merchants, but also exposes each merchant's LenderId -- used by the Admin
    access editor to let an admin filter the merchant grant checkboxes down to one lender's
    merchants instead of scrolling the full list. Many merchants have no LenderId set at all,
    so callers must still offer an "all merchants" / "no lender" view alongside the filter,
    not just per-lender groups."""
    sql = """
        SELECT TOP (:limit) Id AS merchant_id, Name AS merchant_name, LenderId AS lender_id
        FROM Merchants
        WHERE IsDeleted = 0
        ORDER BY Name
    """
    return run_query(sql, {"limit": limit}, region=region)


@cached(ttl=300)
def get_daily_application_volume(region: str, merchant_id: str, date_from: date, date_to: date) -> list[dict]:
    sql = """
        SELECT
            CAST(dbo.TicksToDatetime2(A.DateCreated) AS DATE) AS application_date,
            COUNT(*) AS total_applications,
            SUM(CASE WHEN A.ApplicationStatus = 'Accepted' THEN 1 ELSE 0 END) AS approved_count,
            SUM(CASE WHEN A.ApplicationStatus = 'Declined' THEN 1 ELSE 0 END) AS declined_count,
            CAST(SUM(CASE WHEN A.ApplicationStatus = 'Accepted' THEN 1 ELSE 0 END) AS DECIMAL(10, 4))
                / NULLIF(COUNT(*), 0) AS approval_rate
        FROM Applications AS A
        WHERE CAST(dbo.TicksToDatetime2(A.DateCreated) AS DATE) BETWEEN :date_from AND :date_to
          AND A.MerchentId = :merchant_id
        GROUP BY CAST(dbo.TicksToDatetime2(A.DateCreated) AS DATE)
        ORDER BY application_date DESC
    """
    return run_query(sql, {"date_from": date_from, "date_to": date_to, "merchant_id": merchant_id}, region=region)


@cached(ttl=60)
def get_stuck_applications(region: str, merchant_id: str, excluded_statuses: list[str], stale_after_hours: float) -> list[dict]:
    sql = """
        SELECT
            la.Id AS application_id,
            la.ApplicationStatus AS application_status,
            dbo.TicksToDatetime2(la.DateCreated) AS date_created,
            DATEDIFF(HOUR, dbo.TicksToDatetime2(la.DateCreated), GETDATE()) AS hours_in_current_status
        FROM Applications AS la
        WHERE la.ApplicationStatus NOT IN :excluded_statuses
          AND la.MerchentId = :merchant_id
          AND dbo.TicksToDatetime2(la.DateCreated) <= DATEADD(HOUR, -:stale_after_hours, GETDATE())
        ORDER BY la.DateCreated ASC
    """
    return run_query(sql, {
        "excluded_statuses": tuple(excluded_statuses),
        "merchant_id": merchant_id,
        "stale_after_hours": stale_after_hours,
    }, region=region)


@cached(ttl=60)
def get_stuck_applications_overview(region: str, excluded_statuses: list[str], stale_after_hours: float, limit: int = 500) -> list[dict]:
    """Like get_stuck_applications, but across every merchant at once (unfiltered, same
    convention as get_top_merchants_last_month) -- feeds both the Overview alert tile and the
    "Stuck applications (all merchants)" Analytics catalog entry. Callers must post-filter
    rows by the requesting user's allowed merchant set."""
    sql = """
        SELECT TOP (:limit)
            la.Id AS application_id,
            la.ApplicationStatus AS application_status,
            la.MerchentId AS merchant_id,
            m.Name AS merchant_name,
            dbo.TicksToDatetime2(la.DateCreated) AS date_created,
            DATEDIFF(HOUR, dbo.TicksToDatetime2(la.DateCreated), GETDATE()) AS hours_in_current_status
        FROM Applications AS la
        INNER JOIN Merchants AS m ON m.Id = la.MerchentId
        WHERE la.ApplicationStatus NOT IN :excluded_statuses
          AND dbo.TicksToDatetime2(la.DateCreated) <= DATEADD(HOUR, -:stale_after_hours, GETDATE())
        ORDER BY la.DateCreated ASC
    """
    return run_query(sql, {
        "limit": limit,
        "excluded_statuses": tuple(excluded_statuses),
        "stale_after_hours": stale_after_hours,
    }, region=region)


@cached(ttl=60)
def get_transaction_failure_rate_by_hour(region: str, merchant_id: str, hours: int = 48) -> list[dict]:
    sql = """
        SELECT
            DATEADD(HOUR, DATEDIFF(HOUR, 0, dbo.TicksToDatetime2(t.DateCreated)), 0) AS hour_bucket_utc,
            COUNT(*) AS total_transactions,
            SUM(CASE WHEN t.Status = 'FAILED' THEN 1 ELSE 0 END) AS failed_transactions,
            CAST(SUM(CASE WHEN t.Status = 'FAILED' THEN 1 ELSE 0 END) AS DECIMAL(10, 4))
                / NULLIF(COUNT(*), 0) AS failure_rate
        FROM PaymentTransactions AS t
        WHERE dbo.TicksToDatetime2(t.DateCreated) >= DATEADD(HOUR, -:hours, GETUTCDATE())
          AND t.MerchantId = :merchant_id
        GROUP BY DATEADD(HOUR, DATEDIFF(HOUR, 0, dbo.TicksToDatetime2(t.DateCreated)), 0)
        ORDER BY hour_bucket_utc DESC
    """
    return run_query(sql, {"hours": hours, "merchant_id": merchant_id}, region=region)


@cached(ttl=300)
def get_lender_performance(region: str, lender_id: str, date_from: date, date_to: date) -> list[dict]:
    sql = """
        SELECT
            COUNT(la.Id) AS total_applications,
            SUM(CASE WHEN la.ApplicationStatus = 'Accepted' THEN 1 ELSE 0 END) AS approved_count,
            CAST(SUM(CASE WHEN la.ApplicationStatus = 'Accepted' THEN 1 ELSE 0 END) AS DECIMAL(10, 4))
                / NULLIF(COUNT(la.Id), 0) AS approval_rate,
            AVG(CASE WHEN la.ApplicationStatus = 'Accepted' THEN la.RequestedAmount END) AS avg_approved_amount
        FROM Applications AS la
        WHERE CAST(dbo.TicksToDatetime2(la.DateCreated) AS DATE) BETWEEN :date_from AND :date_to
          AND la.LenderId = :lender_id
    """
    return run_query(sql, {"date_from": date_from, "date_to": date_to, "lender_id": lender_id}, region=region)


@cached(ttl=60)
def get_transaction_failures_by_status(region: str, merchant_id: str, hours: int = 24) -> list[dict]:
    """Ported from 1.2 -- failed/errored transactions grouped by status, last N hours."""
    sql = """
        SELECT
            t.Status AS status,
            COUNT(*) AS failed_count,
            MIN(dbo.TicksToDatetime2(t.DateCreated)) AS first_failure_utc,
            MAX(dbo.TicksToDatetime2(t.DateCreated)) AS last_failure_utc
        FROM PaymentTransactions AS t
        WHERE t.MerchantId = :merchant_id
          AND dbo.TicksToDatetime2(t.DateCreated) >= DATEADD(HOUR, -:hours, GETUTCDATE())
        GROUP BY t.Status
        ORDER BY failed_count DESC
    """
    return run_query(sql, {"merchant_id": merchant_id, "hours": hours}, region=region)


@cached(ttl=900)
def get_top_merchants_last_month(region: str) -> list[dict]:
    """Ported from 2.2 -- top merchants by originated volume, last full calendar month.
    Unfiltered by merchant -- callers must post-filter rows by the requesting user's
    allowed merchant set (see app/query_catalog.py)."""
    sql = """
        WITH LastMonthBounds AS (
            SELECT
                DATEFROMPARTS(YEAR(DATEADD(MONTH, -1, GETUTCDATE())), MONTH(DATEADD(MONTH, -1, GETUTCDATE())), 1) AS MonthStart,
                EOMONTH(DATEADD(MONTH, -1, GETUTCDATE())) AS MonthEnd
        )
        SELECT
            m.Id AS merchant_id,
            m.Name AS merchant_name,
            COUNT(A.Id) AS total_applications,
            SUM(A.RequestedAmount) AS total_requested_amount,
            SUM(CASE WHEN A.ApplicationStatus = 'Accepted' THEN A.RequestedAmount ELSE 0 END) AS total_accepted_amount,
            AVG(A.RequestedAmount) AS avg_requested_amount
        FROM Applications AS A
        INNER JOIN Merchants AS m ON m.Id = A.MerchentId
        CROSS JOIN LastMonthBounds AS b
        WHERE CAST(dbo.TicksToDatetime2(A.DateCreated) AS DATE) BETWEEN b.MonthStart AND b.MonthEnd
          AND m.IsDeleted = 0
        GROUP BY m.Id, m.Name
        ORDER BY total_requested_amount DESC
    """
    return run_query(sql, region=region)


@cached(ttl=900)
def get_monthly_growth(region: str, merchant_id: str, months: int = 13) -> list[dict]:
    """Ported from 2.3 -- month-over-month growth in originated volume, scoped to one
    merchant (the original query aggregated across ALL merchants with no filter, which
    would leak cross-merchant totals to a non-admin -- scoping it is a deliberate change)."""
    sql = """
        WITH MonthlyVolume AS (
            SELECT
                DATEFROMPARTS(YEAR(dbo.TicksToDatetime2(A.DateCreated)), MONTH(dbo.TicksToDatetime2(A.DateCreated)), 1) AS month_start,
                COUNT(*) AS application_count,
                SUM(A.RequestedAmount) AS total_requested
            FROM Applications AS A
            WHERE dbo.TicksToDatetime2(A.DateCreated) >= DATEADD(MONTH, -:months, GETUTCDATE())
              AND A.MerchentId = :merchant_id
            GROUP BY DATEFROMPARTS(YEAR(dbo.TicksToDatetime2(A.DateCreated)), MONTH(dbo.TicksToDatetime2(A.DateCreated)), 1)
        )
        SELECT
            month_start,
            application_count,
            total_requested,
            LAG(total_requested) OVER (ORDER BY month_start) AS prev_month_total,
            CAST(total_requested - LAG(total_requested) OVER (ORDER BY month_start) AS DECIMAL(18, 2))
                / NULLIF(LAG(total_requested) OVER (ORDER BY month_start), 0) AS mom_growth_rate
        FROM MonthlyVolume
        ORDER BY month_start
    """
    return run_query(sql, {"months": months, "merchant_id": merchant_id}, region=region)


@cached(ttl=300)
def get_application_by_id(region: str, application_id: str) -> list[dict]:
    """Ported from 3.2 -- a single application with merchant/lender/customer context."""
    sql = """
        SELECT
            la.Id AS application_id,
            la.ApplicationStatus AS application_status,
            la.RequestedAmount AS requested_amount,
            dbo.TicksToDatetime2(la.DateCreated) AS date_created,
            la.MerchentId AS merchant_id,
            m.Name AS merchant_name,
            la.LenderId AS lender_id,
            l.Name AS lender_name,
            c.FirstName AS customer_first_name,
            c.LastName AS customer_last_name,
            c.Email AS customer_email
        FROM Applications AS la
        LEFT JOIN Merchants AS m ON m.Id = la.MerchentId
        LEFT JOIN Lenders AS l ON l.Id = la.LenderId
        LEFT JOIN Customers AS c ON c.Id = la.CustomerId
        WHERE la.Id = :application_id
    """
    return run_query(sql, {"application_id": application_id}, region=region)


@cached(ttl=120)
def get_transactions_by_application(region: str, application_id: str) -> list[dict]:
    """Ported from 3.3 -- payment history for a single application. Joins Applications only
    to expose MerchentId, so the caller can enforce merchant-based access on the result."""
    sql = """
        SELECT
            t.Id AS transaction_id,
            t.ApplicationId AS application_id,
            t.Type AS transaction_type,
            t.Amount AS amount,
            t.Status AS status,
            dbo.TicksToDatetime2(t.DateCreated) AS date_created,
            a.MerchentId AS merchant_id
        FROM PaymentTransactions AS t
        INNER JOIN Applications AS a ON a.Id = t.ApplicationId
        WHERE t.ApplicationId = :application_id
        ORDER BY t.DateCreated DESC
    """
    return run_query(sql, {"application_id": application_id}, region=region)


@cached(ttl=60)
def search_customers(region: str, search_term: str) -> list[dict]:
    """Ported from 3.1 -- customer + application history by email or phone. Unfiltered by
    merchant -- callers must post-filter rows by the requesting user's allowed merchant set."""
    sql = """
        SELECT
            c.Id AS customer_id,
            c.FirstName AS first_name,
            c.LastName AS last_name,
            c.Email AS email,
            c.MobilePhone AS mobile_phone,
            la.Id AS application_id,
            la.ApplicationStatus AS application_status,
            dbo.TicksToDatetime2(la.DateCreated) AS date_created,
            la.RequestedAmount AS requested_amount,
            la.MerchentId AS merchant_id
        FROM Customers AS c
        LEFT JOIN Applications AS la ON la.CustomerId = c.Id
        WHERE c.Email = :search_term OR c.MobilePhone = :search_term
        ORDER BY la.DateCreated DESC
    """
    return run_query(sql, {"search_term": search_term}, region=region)


@cached(ttl=600)
def get_merchants_by_lender(region: str, lender_id: str) -> list[dict]:
    """Ported from 3.4 -- merchants tied to a given lender."""
    sql = """
        SELECT
            m.Id AS merchant_id,
            m.Name AS merchant_name,
            m.Status AS status,
            dbo.TicksToDatetime2(m.DateCreated) AS date_created,
            m.BaseURL AS base_url
        FROM Merchants AS m
        WHERE m.LenderId = :lender_id
          AND m.IsDeleted = 0
        ORDER BY m.Name
    """
    return run_query(sql, {"lender_id": lender_id}, region=region)


@cached(ttl=120)
def get_daily_activity_by_week(region: str, merchant_id: str, days: int = 7) -> list[dict]:
    """Daily (not hourly) transaction activity for the last N days -- default one week.
    Same shape as get_transaction_failure_rate_by_hour but bucketed by day, for a weekly
    view instead of an hourly one."""
    sql = """
        SELECT
            CAST(dbo.TicksToDatetime2(t.DateCreated) AS DATE) AS activity_date,
            COUNT(*) AS total_transactions,
            SUM(CASE WHEN t.Status = 'FAILED' THEN 1 ELSE 0 END) AS failed_transactions,
            CAST(SUM(CASE WHEN t.Status = 'FAILED' THEN 1 ELSE 0 END) AS DECIMAL(10, 4))
                / NULLIF(COUNT(*), 0) AS failure_rate
        FROM PaymentTransactions AS t
        WHERE dbo.TicksToDatetime2(t.DateCreated) >= DATEADD(DAY, -:days, GETUTCDATE())
          AND t.MerchantId = :merchant_id
        GROUP BY CAST(dbo.TicksToDatetime2(t.DateCreated) AS DATE)
        ORDER BY activity_date ASC
    """
    return run_query(sql, {"days": days, "merchant_id": merchant_id}, region=region)


@cached(ttl=300)
def get_applications_by_weekday(region: str, merchant_id: str, date_from: date, date_to: date) -> list[dict]:
    """Application volume grouped by day of week over a date range -- surfaces which weekdays
    run busiest/slowest for a merchant, complementing the day-by-day trend in
    get_daily_application_volume."""
    sql = """
        SELECT
            DATENAME(WEEKDAY, dbo.TicksToDatetime2(A.DateCreated)) AS weekday_name,
            DATEPART(WEEKDAY, dbo.TicksToDatetime2(A.DateCreated)) AS weekday_number,
            COUNT(*) AS total_applications,
            SUM(CASE WHEN A.ApplicationStatus = 'Accepted' THEN 1 ELSE 0 END) AS approved_count
        FROM Applications AS A
        WHERE CAST(dbo.TicksToDatetime2(A.DateCreated) AS DATE) BETWEEN :date_from AND :date_to
          AND A.MerchentId = :merchant_id
        GROUP BY
            DATENAME(WEEKDAY, dbo.TicksToDatetime2(A.DateCreated)),
            DATEPART(WEEKDAY, dbo.TicksToDatetime2(A.DateCreated))
        ORDER BY weekday_number
    """
    return run_query(sql, {"date_from": date_from, "date_to": date_to, "merchant_id": merchant_id}, region=region)
