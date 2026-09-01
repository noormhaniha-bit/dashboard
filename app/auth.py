from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app import config, security
from app.db import get_db
from app.models import User, UserRole


def _user_from_cookie(request: Request, db: Session) -> User | None:
    token = request.cookies.get(config.SESSION_COOKIE_NAME)
    if not token:
        return None
    user_id = security.read_session_token(token)
    if user_id is None:
        return None
    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()  # noqa: E712
    return user


def get_current_user_or_none(request: Request, db: Session = Depends(get_db)) -> User | None:
    """For page routes, which redirect to /login instead of raising -- see main.py."""
    return _user_from_cookie(request, db)


def require_user(request: Request, db: Session = Depends(get_db)) -> User:
    """For API routes -- returns 401 JSON rather than a redirect, since callers are fetch()."""
    user = _user_from_cookie(request, db)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    if user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user
