from datetime import datetime, timezone
from enum import StrEnum

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class UserRole(StrEnum):
    ADMIN = "admin"
    MEMBER = "member"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default=UserRole.MEMBER)
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    # TOTP two-factor auth. totp_secret is set as soon as setup starts, but totp_enabled
    # only flips to True once the user proves they scanned it correctly (see /api/security/2fa/confirm)
    # -- a half-finished setup must never count as "2FA is on" for this account.
    totp_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(default=False)

    grants = relationship("AccessGrant", back_populates="user", cascade="all, delete-orphan")


class AccessGrantType(StrEnum):
    PDF_LENDER = "pdf_lender"              # a lender folder name under REPORTS_ROOT_DIR
    ANALYTICS_LENDER = "analytics_lender"  # a Lenders.Id from the SQL replica -- also grants
    # visibility into every merchant under that lender, see access.allowed_analytics_merchants


class AccessGrant(Base):
    """One row = one teammate can see one resource. A user with role=admin bypasses grants
    entirely and sees everything; a non-admin with zero grants of a given type sees nothing
    of that type -- access is opt-in, not opt-out."""

    __tablename__ = "access_grants"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    resource_type: Mapped[str] = mapped_column(String(30))
    resource_key: Mapped[str] = mapped_column(String(255))
    resource_label: Mapped[str] = mapped_column(String(255), default="")

    user = relationship("User", back_populates="grants")


class ActivityLog(Base):
    """An append-only audit trail of who did what -- PDF access, admin account/access changes,
    FullStory job triggers. user_email is stored directly (not just a user_id FK) so the
    history still reads sensibly after the account itself is deleted."""

    __tablename__ = "activity_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    user_email: Mapped[str] = mapped_column(String(255))
    action: Mapped[str] = mapped_column(String(50))
    resource: Mapped[str] = mapped_column(String(255), default="")
    detail: Mapped[str] = mapped_column(String(500), default="")
