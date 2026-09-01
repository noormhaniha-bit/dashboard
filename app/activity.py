"""Append-only audit trail: who did what, when. Deliberately simple -- no queue, no async,
just an insert on the same request that performed the action. See app/models.py:ActivityLog.
"""

from sqlalchemy.orm import Session

from app.models import ActivityLog


def log_activity(db: Session, user_email: str, action: str, resource: str = "", detail: str = "") -> None:
    db.add(ActivityLog(user_email=user_email, action=action, resource=resource, detail=detail))
    db.commit()


def list_activity(db: Session, limit: int = 300) -> list[dict]:
    rows = db.query(ActivityLog).order_by(ActivityLog.created_at.desc()).limit(limit).all()
    return [
        {
            "id": r.id,
            "created_at": r.created_at.isoformat(),
            "user_email": r.user_email,
            "action": r.action,
            "resource": r.resource,
            "detail": r.detail,
        }
        for r in rows
    ]
