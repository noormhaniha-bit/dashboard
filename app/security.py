import bcrypt
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app import config

# Explicit truncation, not left to bcrypt to raise on -- see the note in the SLA-automation
# backend's app/core/security.py for why this can't be left to passlib/bcrypt defaults.
_MAX_PASSWORD_BYTES = 72

_serializer = URLSafeTimedSerializer(config.SESSION_SECRET_KEY, salt="session")
# Distinct salt -- cryptographically separates "logged in" tokens from "password checked,
# waiting on a TOTP code" tokens, so a pending-2FA token can never be replayed as a real
# session even though both use the same underlying secret key.
_pending_2fa_serializer = URLSafeTimedSerializer(config.SESSION_SECRET_KEY, salt="pending-2fa")
PENDING_2FA_MAX_AGE_SECONDS = 5 * 60


def hash_password(plain_password: str) -> str:
    password_bytes = plain_password.encode("utf-8")[:_MAX_PASSWORD_BYTES]
    return bcrypt.hashpw(password_bytes, bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    password_bytes = plain_password.encode("utf-8")[:_MAX_PASSWORD_BYTES]
    return bcrypt.checkpw(password_bytes, hashed_password.encode("utf-8"))


def create_session_token(user_id: int) -> str:
    return _serializer.dumps({"user_id": user_id})


def read_session_token(token: str) -> int | None:
    try:
        data = _serializer.loads(token, max_age=config.SESSION_MAX_AGE_SECONDS)
    except (BadSignature, SignatureExpired):
        return None
    return data.get("user_id")


def create_pending_2fa_token(user_id: int) -> str:
    return _pending_2fa_serializer.dumps({"user_id": user_id})


def read_pending_2fa_token(token: str) -> int | None:
    try:
        data = _pending_2fa_serializer.loads(token, max_age=PENDING_2FA_MAX_AGE_SECONDS)
    except (BadSignature, SignatureExpired):
        return None
    return data.get("user_id")
