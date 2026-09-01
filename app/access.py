"""Per-user visibility over PDF lender folders and analytics merchants/lenders.

An admin bypasses all of this and sees everything. A non-admin sees only what's been
explicitly granted -- fail-closed, not fail-open, so a brand-new teammate account starts
with zero visibility until an admin grants some.

Analytics lender grants are region-scoped: the US and EU replicas are separate databases, so
a lender_id from one has no relationship to (and could even collide with) a lender_id from
the other. Each ANALYTICS_LENDER grant's resource_key is stored as "<REGION>:<lender_id>" (see
region_lender_key below) so a grant from one region is never mistaken for the other.
"""

from sqlalchemy.orm import Session

from app.models import AccessGrant, AccessGrantType, User, UserRole

ALL_ACCESS = None  # sentinel meaning "admin -- no filtering"


def region_lender_key(region: str, lender_id: str) -> str:
    return f"{region}:{lender_id}"


def _granted_keys(db: Session, user: User, resource_type: str) -> set[str] | None:
    if user.role == UserRole.ADMIN:
        return ALL_ACCESS
    rows = db.query(AccessGrant.resource_key).filter(
        AccessGrant.user_id == user.id, AccessGrant.resource_type == resource_type
    ).all()
    return {r[0] for r in rows}


def allowed_pdf_lenders(db: Session, user: User) -> set[str] | None:
    return _granted_keys(db, user, AccessGrantType.PDF_LENDER)


def allowed_analytics_lenders(db: Session, user: User, region: str) -> set[str] | None:
    """Raw (un-prefixed) lender_ids the user can see within `region`."""
    granted = _granted_keys(db, user, AccessGrantType.ANALYTICS_LENDER)
    if granted is ALL_ACCESS:
        return ALL_ACCESS
    prefix = f"{region}:"
    return {key[len(prefix):] for key in granted if key.startswith(prefix)}


def allowed_analytics_merchants(db: Session, user: User, region: str) -> set[str] | None:
    """Derived from lender grants, not a separate per-merchant grant -- an admin only grants
    lenders, and a user can see a merchant if it belongs to one of their granted lenders in
    this region. Merchants with no LenderId set (about 75% of the merchant table, per a
    real-data check) can't be reached this way and are only visible to admins."""
    allowed_lenders = allowed_analytics_lenders(db, user, region)
    if allowed_lenders is ALL_ACCESS:
        return ALL_ACCESS
    if not allowed_lenders:
        return set()

    from app import analytics_queries
    from app.analytics_db import AnalyticsNotConfigured

    try:
        merchants = analytics_queries.list_merchants_with_lender(region)
    except AnalyticsNotConfigured:
        return set()
    return {m["merchant_id"] for m in merchants if m["lender_id"] in allowed_lenders}


def can_access(allowed: set[str] | None, key: str) -> bool:
    """allowed is None for admins (everything allowed); otherwise membership check."""
    return allowed is ALL_ACCESS or key in allowed


def replace_grants(db: Session, user: User, resource_type: str, items: list[dict]) -> None:
    """items: [{"key": ..., "label": ...}, ...]. Full replace, not incremental --
    matches a checkbox-list admin UI where the whole set is resubmitted each save."""
    db.query(AccessGrant).filter(AccessGrant.user_id == user.id, AccessGrant.resource_type == resource_type).delete()
    for item in items:
        db.add(AccessGrant(user_id=user.id, resource_type=resource_type, resource_key=item["key"], resource_label=item.get("label", "")))
    db.commit()
