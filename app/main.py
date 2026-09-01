import logging
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import access, activity, analytics_queries, config, fullstory_jobs, lenders, reports, security, totp
from app.analytics_cache import warm_startup
from app.analytics_db import AnalyticsNotConfigured
from app.auth import get_current_user_or_none, require_admin, require_user
from app.db import SessionLocal, get_db, init_db
from app.fullstory_jobs import FullStoryAutomationNotFound, JobAlreadyRunning
from app.models import AccessGrantType, User, UserRole
from app.query_catalog import QUERY_CATALOG, QUERY_REGISTRY
from app.reports import ReportsRootNotConfigured

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    db = SessionLocal()
    try:
        if db.query(User).count() == 0:
            logger.warning(
                "No users exist yet. Create the first admin with: "
                "python -m scripts.create_admin you@jifiti.com"
            )
    finally:
        db.close()

    if config.ANALYTICS_DB_CONFIGURED:
        # Pre-run the parameterless / rarely-changing analytics queries now, in the
        # background, so the Analytics page's merchant/lender dropdowns and "top merchants"
        # query are already cached by the time the first person opens it -- instead of that
        # first "Run Query" click paying for the SQL Server round-trip.
        warm_startup([
            ("merchant list", analytics_queries.list_merchants),
            ("lender list", analytics_queries.list_lenders),
            ("top merchants (last month)", analytics_queries.get_top_merchants_last_month),
        ])

    yield


app = FastAPI(title="Ops Dashboard", lifespan=lifespan)

STATIC_DIR = Path(__file__).resolve().parents[1] / "static"


class NoStoreStaticFiles(StaticFiles):
    """Same rationale as _NO_STORE_HEADERS below, applied to /assets/*.js and *.css: with no
    Cache-Control header at all, browsers cache these heuristically and can keep serving a
    stale script/stylesheet after a deploy until the user hard-refreshes."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response


app.mount("/assets", NoStoreStaticFiles(directory=STATIC_DIR / "assets"), name="assets")


def _run_analytics(query_fn, *args, **kwargs):
    try:
        return query_fn(*args, **kwargs)
    except AnalyticsNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))


def _require_key_access(allowed: set[str] | None, key: str, what: str):
    if not access.can_access(allowed, key):
        raise HTTPException(status_code=403, detail=f"You don't have access to this {what}.")


# ---------------------------------------------------------------------------
# Page routes (HTML shells) -- gated server-side, redirect rather than 401
# ---------------------------------------------------------------------------


# FileResponse sets Last-Modified/ETag from the file's stat but no Cache-Control, which
# leaves browsers free to reuse a cached copy heuristically on a plain navigation (not just
# a conditional revalidated GET) -- exactly what caused a stale, pre-redesign index.html to
# stick around and crash against a newer app.js expecting different element ids. These are
# dynamic, auth-gated shells; they should never be cached client-side.
_NO_STORE_HEADERS = {"Cache-Control": "no-store"}


@app.get("/login")
def login_page(request: Request, db: Session = Depends(get_db)):
    if get_current_user_or_none(request, db):
        return RedirectResponse("/")
    return FileResponse(STATIC_DIR / "login.html", headers=_NO_STORE_HEADERS)


@app.get("/overview")
def overview_page(request: Request, db: Session = Depends(get_db)):
    if not get_current_user_or_none(request, db):
        return RedirectResponse("/login")
    return FileResponse(STATIC_DIR / "overview.html", headers=_NO_STORE_HEADERS)


@app.get("/")
def index_page(request: Request, db: Session = Depends(get_db)):
    if not get_current_user_or_none(request, db):
        return RedirectResponse("/login")
    return FileResponse(STATIC_DIR / "index.html", headers=_NO_STORE_HEADERS)


@app.get("/analytics")
def analytics_page(request: Request, db: Session = Depends(get_db)):
    if not get_current_user_or_none(request, db):
        return RedirectResponse("/login")
    return FileResponse(STATIC_DIR / "analytics.html", headers=_NO_STORE_HEADERS)


@app.get("/security")
def security_page(request: Request, db: Session = Depends(get_db)):
    if not get_current_user_or_none(request, db):
        return RedirectResponse("/login")
    return FileResponse(STATIC_DIR / "security.html", headers=_NO_STORE_HEADERS)


@app.get("/fullstory")
def fullstory_page(request: Request, db: Session = Depends(get_db)):
    if not get_current_user_or_none(request, db):
        return RedirectResponse("/login")
    return FileResponse(STATIC_DIR / "fullstory.html", headers=_NO_STORE_HEADERS)


@app.get("/admin")
def admin_page(request: Request, db: Session = Depends(get_db)):
    user = get_current_user_or_none(request, db)
    if not user:
        return RedirectResponse("/login")
    if user.role != UserRole.ADMIN:
        return RedirectResponse("/")
    return FileResponse(STATIC_DIR / "admin.html", headers=_NO_STORE_HEADERS)


@app.get("/activity")
def activity_page(request: Request, db: Session = Depends(get_db)):
    user = get_current_user_or_none(request, db)
    if not user:
        return RedirectResponse("/login")
    if user.role != UserRole.ADMIN:
        return RedirectResponse("/")
    return FileResponse(STATIC_DIR / "activity.html", headers=_NO_STORE_HEADERS)


@app.get("/lenders")
def lenders_page(request: Request, db: Session = Depends(get_db)):
    if not get_current_user_or_none(request, db):
        return RedirectResponse("/login")
    return FileResponse(STATIC_DIR / "lenders.html", headers=_NO_STORE_HEADERS)


@app.get("/lender/{slug}")
def lender_detail_page(slug: str, request: Request, db: Session = Depends(get_db)):
    if not get_current_user_or_none(request, db):
        return RedirectResponse("/login")
    return FileResponse(STATIC_DIR / "lender.html", headers=_NO_STORE_HEADERS)


# ---------------------------------------------------------------------------
# Auth API
# ---------------------------------------------------------------------------


class LoginRequest(BaseModel):
    email: str
    password: str


class VerifyTotpRequest(BaseModel):
    pending_token: str
    code: str


def _set_session_cookie(response: Response, user_id: int) -> None:
    token = security.create_session_token(user_id)
    response.set_cookie(
        config.SESSION_COOKIE_NAME,
        token,
        max_age=config.SESSION_MAX_AGE_SECONDS,
        httponly=True,
        samesite="lax",
        secure=config.SESSION_COOKIE_SECURE,
    )


@app.post("/api/auth/login")
def login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == payload.email, User.is_active == True).first()  # noqa: E712
    if not user or not security.verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Incorrect email or password")

    if user.totp_enabled:
        # Password is correct but the session isn't granted yet -- a short-lived, distinctly
        # salted token stands in until the TOTP code also checks out (see verify-totp below).
        return {"requires_totp": True, "pending_token": security.create_pending_2fa_token(user.id)}

    _set_session_cookie(response, user.id)
    return {"ok": True, "role": user.role, "requires_totp": False}


@app.post("/api/auth/verify-totp")
def verify_totp(payload: VerifyTotpRequest, response: Response, db: Session = Depends(get_db)):
    user_id = security.read_pending_2fa_token(payload.pending_token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="This login attempt has expired. Please sign in again.")

    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()  # noqa: E712
    if not user or not user.totp_enabled or not user.totp_secret:
        raise HTTPException(status_code=401, detail="Please sign in again.")

    if not totp.verify_code(user.totp_secret, payload.code):
        raise HTTPException(status_code=401, detail="Incorrect code")

    _set_session_cookie(response, user.id)
    return {"ok": True, "role": user.role}


@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie(config.SESSION_COOKIE_NAME)
    return {"ok": True}


@app.get("/api/auth/me")
def me(user: User = Depends(require_user)):
    return {"id": user.id, "email": user.email, "role": user.role, "totp_enabled": user.totp_enabled}


# ---------------------------------------------------------------------------
# Security: two-factor auth setup, self-service. A secret is written to the account as
# soon as setup starts, but totp_enabled only flips on in /confirm -- so an abandoned setup
# never silently turns on 2FA the user hasn't actually verified they can generate codes for.
# ---------------------------------------------------------------------------


class TotpCodeRequest(BaseModel):
    code: str


@app.get("/api/security/2fa/status")
def get_2fa_status(user: User = Depends(require_user)):
    return {"enabled": user.totp_enabled}


@app.post("/api/security/2fa/setup")
def setup_2fa(user: User = Depends(require_user), db: Session = Depends(get_db)):
    if user.totp_enabled:
        raise HTTPException(status_code=409, detail="Two-factor auth is already enabled. Disable it first to re-enroll.")

    secret = totp.generate_secret()
    user.totp_secret = secret
    db.commit()

    uri = totp.provisioning_uri(secret, user.email)
    return {"secret": secret, "qr_code_data_uri": totp.qr_code_data_uri(uri)}


@app.post("/api/security/2fa/confirm")
def confirm_2fa(payload: TotpCodeRequest, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if not user.totp_secret:
        raise HTTPException(status_code=400, detail="Start setup first.")
    if not totp.verify_code(user.totp_secret, payload.code):
        raise HTTPException(status_code=401, detail="Incorrect code")

    user.totp_enabled = True
    db.commit()
    return {"ok": True}


@app.post("/api/security/2fa/disable")
def disable_2fa(payload: TotpCodeRequest, user: User = Depends(require_user), db: Session = Depends(get_db)):
    if not user.totp_enabled:
        raise HTTPException(status_code=400, detail="Two-factor auth isn't enabled.")
    if not user.totp_secret or not totp.verify_code(user.totp_secret, payload.code):
        raise HTTPException(status_code=401, detail="Incorrect code")

    user.totp_enabled = False
    user.totp_secret = None
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# PDF reports -- filtered by the current user's granted lenders
# ---------------------------------------------------------------------------


@app.get("/api/reports")
def get_reports(user: User = Depends(require_user), db: Session = Depends(get_db)):
    allowed = access.allowed_pdf_lenders(db, user)
    if allowed is not None and not allowed:
        return []
    try:
        return reports.list_reports(allowed_lenders=allowed)
    except ReportsRootNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/api/lenders")
def get_lenders_index(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Canonical lenders the current user has PDF access to -- feeds the /lenders index and
    the /lender/<slug> detail pages. Deliberately scoped to PDF access (not the union of PDF +
    analytics access): unlike get_admin_options, this is user-facing, so it must not reveal a
    lender's existence to someone who can't see it anywhere else in the app."""
    allowed = access.allowed_pdf_lenders(db, user)

    existing_folders = set()
    try:
        existing_folders = set(reports.list_all_lender_names())
    except ReportsRootNotConfigured:
        pass

    result = []
    for name in lenders.CANONICAL_LENDERS:
        folder_key = lenders.folder_name_for(name)
        if not access.can_access(allowed, folder_key):
            continue
        result.append({
            "slug": lenders.slug_for(name),
            "name": name,
            "folder_key": folder_key,
            "has_reports": folder_key in existing_folders,
        })
    return result


@app.get("/api/pdf/{rel_path:path}")
def get_pdf(rel_path: str, user: User = Depends(require_user), db: Session = Depends(get_db)):
    try:
        path = reports.resolve_pdf_path(rel_path)
    except ReportsRootNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Report not found")

    # Access is checked against the RESOLVED path's lender folder, not the raw client
    # string -- checking the raw string (e.g. its first "/"-segment) would let a request
    # like "FECI/../AGOS/..." pass the check under an allowed prefix while
    # resolve_pdf_path's traversal-safe resolution still serves the real AGOS file.
    allowed = access.allowed_pdf_lenders(db, user)
    actual_lender_name = path.relative_to(config.REPORTS_ROOT_DIR.resolve()).parts[0]
    _require_key_access(allowed, actual_lender_name, "report")

    activity.log_activity(db, user.email, "pdf_access", actual_lender_name, path.name)
    return FileResponse(path, media_type="application/pdf", filename=path.name)


# ---------------------------------------------------------------------------
# Analytics -- a query catalog (pick a query, get that query's own inputs, get a
# table + chart) rather than one bespoke endpoint per query. Every runner enforces
# access itself; see app/query_catalog.py for why the rule differs by query shape.
# ---------------------------------------------------------------------------


@app.get("/api/analytics/merchants")
def get_merchants(lender_id: str | None = None, user: User = Depends(require_user), db: Session = Depends(get_db)):
    allowed = access.allowed_analytics_merchants(db, user)
    if lender_id:
        rows = _run_analytics(analytics_queries.get_merchants_by_lender, lender_id)
    else:
        rows = _run_analytics(analytics_queries.list_merchants)
    if allowed is None:
        return rows
    return [r for r in rows if r["merchant_id"] in allowed]


@app.get("/api/analytics/lenders")
def get_lenders(user: User = Depends(require_user), db: Session = Depends(get_db)):
    allowed = access.allowed_analytics_lenders(db, user)
    rows = _run_analytics(analytics_queries.list_lenders)
    if allowed is None:
        return rows
    return [r for r in rows if r["lender_id"] in allowed]


@app.get("/api/analytics/catalog")
def get_query_catalog(_user: User = Depends(require_user)):
    return [
        {
            "id": q.id,
            "label": q.label,
            "category": q.category,
            "description": q.description,
            "params": [asdict(p) for p in q.params],
            "chart": q.chart,
        }
        for q in QUERY_CATALOG
    ]


@app.get("/api/analytics/run")
def run_query(query_id: str, request: Request, user: User = Depends(require_user), db: Session = Depends(get_db)):
    spec = QUERY_REGISTRY.get(query_id)
    if not spec:
        raise HTTPException(status_code=404, detail="Unknown query")

    params: dict = {}
    for p in spec.params:
        raw = request.query_params.get(p.name)
        if raw is None or raw == "":
            if p.required:
                raise HTTPException(status_code=400, detail=f"'{p.label}' is required")
            raw = p.default
        params[p.name] = raw

    try:
        rows = spec.runner(params, user, db)
    except AnalyticsNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e))

    columns = list(rows[0].keys()) if rows else []
    return {"columns": columns, "rows": rows, "chart": spec.chart}


# ---------------------------------------------------------------------------
# Admin: user management + per-user access grants ("manage the views for teammates")
# ---------------------------------------------------------------------------


class CreateUserRequest(BaseModel):
    email: str
    password: str
    role: str = UserRole.MEMBER


class UpdateUserRequest(BaseModel):
    role: str | None = None
    is_active: bool | None = None
    new_password: str | None = None


class AccessItem(BaseModel):
    key: str
    label: str = ""


class SetAccessRequest(BaseModel):
    pdf_lenders: list[AccessItem] = []
    analytics_lenders: list[AccessItem] = []


@app.get("/api/admin/users", dependencies=[Depends(require_admin)])
def list_users(db: Session = Depends(get_db)):
    users = db.query(User).order_by(User.email).all()
    return [
        {"id": u.id, "email": u.email, "role": u.role, "is_active": u.is_active, "totp_enabled": u.totp_enabled}
        for u in users
    ]


@app.post("/api/admin/users")
def create_user(payload: CreateUserRequest, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    user = User(email=payload.email, hashed_password=security.hash_password(payload.password), role=payload.role)
    db.add(user)
    db.commit()
    db.refresh(user)
    activity.log_activity(db, admin.email, "user_create", user.email, f"role={user.role}")
    return {"id": user.id, "email": user.email, "role": user.role, "is_active": user.is_active}


@app.patch("/api/admin/users/{user_id}")
def update_user(user_id: int, payload: UpdateUserRequest, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    changes = []
    if payload.role is not None:
        user.role = payload.role
        changes.append(f"role={payload.role}")
    if payload.is_active is not None:
        user.is_active = payload.is_active
        changes.append(f"is_active={payload.is_active}")
    if payload.new_password:
        user.hashed_password = security.hash_password(payload.new_password)
        changes.append("password_reset")

    db.commit()
    activity.log_activity(db, admin.email, "user_update", user.email, ", ".join(changes))
    return {"id": user.id, "email": user.email, "role": user.role, "is_active": user.is_active}


@app.post("/api/admin/users/{user_id}/reset-2fa")
def reset_2fa(user_id: int, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Account recovery for a lost/reset phone -- turns 2FA off for this user without
    needing their code, since an admin already has elevated trust. They can re-enroll
    from their own Security page afterward."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.totp_enabled = False
    user.totp_secret = None
    db.commit()
    activity.log_activity(db, admin.email, "2fa_reset", user.email)
    return {"ok": True}


@app.get("/api/admin/activity", dependencies=[Depends(require_admin)])
def get_activity(db: Session = Depends(get_db)):
    return activity.list_activity(db)


@app.get("/api/admin/options", dependencies=[Depends(require_admin)])
def get_admin_options():
    """The universe of grantable resources -- used to render the access-editor checkboxes.

    PDF lenders come from the known business lender list (app/lenders.py), not just folders
    that already exist -- so an admin can grant a lender before its first report has landed.
    """
    existing_folders = set()
    try:
        existing_folders = set(reports.list_all_lender_names())
    except ReportsRootNotConfigured:
        pass

    pdf_lenders = [
        {
            "key": lenders.folder_name_for(name),
            "label": name,
            "has_reports": lenders.folder_name_for(name) in existing_folders,
        }
        for name in lenders.CANONICAL_LENDERS
    ]

    # Any real folder not covered by the known list is still grantable -- otherwise a
    # folder that doesn't match the canonical list 1:1 (a rename, a one-off partner, a
    # stray duplicate) would be impossible for an admin to grant to anyone, even though
    # its reports are sitting right there and an admin viewing everything would see it fine.
    covered_folders = {lenders.folder_name_for(name) for name in lenders.CANONICAL_LENDERS}
    for extra_folder in sorted(existing_folders - covered_folders):
        pdf_lenders.append({"key": extra_folder, "label": extra_folder, "has_reports": True})

    sql_lenders = []
    try:
        sql_lenders = analytics_queries.list_lenders()
    except AnalyticsNotConfigured:
        pass

    return {"pdf_lenders": pdf_lenders, "lenders": sql_lenders}


@app.get("/api/admin/users/{user_id}/access", dependencies=[Depends(require_admin)])
def get_user_access(user_id: int, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return {
        "pdf_lenders": sorted(access.allowed_pdf_lenders(db, user) or []),
        "analytics_lenders": sorted(access.allowed_analytics_lenders(db, user) or []),
    }


@app.put("/api/admin/users/{user_id}/access")
def set_user_access(user_id: int, payload: SetAccessRequest, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    access.replace_grants(db, user, AccessGrantType.PDF_LENDER, [i.model_dump() for i in payload.pdf_lenders])
    access.replace_grants(db, user, AccessGrantType.ANALYTICS_LENDER, [i.model_dump() for i in payload.analytics_lenders])
    activity.log_activity(
        db, admin.email, "access_grant_change", user.email,
        f"pdf_lenders={len(payload.pdf_lenders)}, analytics_lenders={len(payload.analytics_lenders)}",
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# FullStory session recording -- launches the Playwright automation (a visible Chrome
# window, driven against app.fullstory.com) as a background subprocess per applicationId.
# Only one recording job runs at a time (see app/fullstory_jobs.py for why).
# ---------------------------------------------------------------------------


@app.post("/api/fullstory/jobs")
async def start_fullstory_job(
    application_ids: str = Form(""),
    file: UploadFile | None = File(None),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """Accepts applicationIds two ways, combinable: a pasted list (comma and/or newline
    separated, or a JSON array) in `application_ids`, and/or an uploaded .json/.txt `file` in
    the same formats. At least one id must come out of the combination."""
    ids: list[str] = []
    if file is not None and file.filename:
        content = await file.read()
        ids.extend(fullstory_jobs.parse_application_ids(content.decode("utf-8", errors="replace")))
    ids.extend(fullstory_jobs.parse_application_ids(application_ids))
    ids = fullstory_jobs.dedupe(ids)

    if not ids:
        raise HTTPException(status_code=400, detail="Provide at least one applicationId -- paste a list and/or upload a file.")

    try:
        job = await fullstory_jobs.start_job(ids, requested_by=user.email)
    except JobAlreadyRunning as e:
        raise HTTPException(status_code=409, detail=str(e))
    except FullStoryAutomationNotFound as e:
        raise HTTPException(status_code=503, detail=str(e))

    activity.log_activity(db, user.email, "fullstory_job_start", job.id, f"{len(ids)} applicationId(s)")
    return job.to_dict()


@app.get("/api/fullstory/jobs")
def list_fullstory_jobs(_user: User = Depends(require_user)):
    return [job.to_dict() for job in fullstory_jobs.list_jobs()]


@app.get("/api/fullstory/jobs/{job_id}")
def get_fullstory_job(job_id: str, _user: User = Depends(require_user)):
    job = fullstory_jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict(include_log=True)
