"""Read-only scanner over an existing SLA-report output directory. Does not generate,
regenerate, or modify anything -- it only lists and serves PDFs that already exist under
REPORTS_ROOT_DIR, expected in the layout <Lender>/<YYYY-MM>/*.pdf used by the existing
multi_lender_generator.py output.
"""

from pathlib import Path

from app import lenders
from app.config import REPORTS_ROOT_DIR


class ReportsRootNotConfigured(Exception):
    pass


def _ensure_root() -> Path:
    if REPORTS_ROOT_DIR is None or not REPORTS_ROOT_DIR.exists():
        raise ReportsRootNotConfigured(
            f"REPORTS_ROOT_DIR is not set to an existing folder (currently: '{REPORTS_ROOT_DIR}')."
        )
    return REPORTS_ROOT_DIR


def list_all_lender_names() -> list[str]:
    """Every lender folder name under the root, unfiltered -- used by the admin access editor
    to build the list of grantable options, independent of any one user's current access."""
    root = _ensure_root()
    return sorted(p.name for p in root.iterdir() if p.is_dir())


def list_reports(allowed_lenders: set[str] | None = None) -> list[dict]:
    """Returns [{lender, periods: [{period, files: [{name, rel_path, size_bytes, modified}]}]}].
    `allowed_lenders`: None means unrestricted (admin); otherwise only these lender folder
    names are included."""
    root = _ensure_root()
    lenders_out = []

    for lender_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        if allowed_lenders is not None and lender_dir.name not in allowed_lenders:
            continue
        periods = []
        for period_dir in sorted((p for p in lender_dir.iterdir() if p.is_dir()), reverse=True):
            pdf_files = sorted(period_dir.glob("*.pdf"))
            if not pdf_files:
                continue
            files = [
                {
                    "name": f.name,
                    "rel_path": str(f.relative_to(root)).replace("\\", "/"),
                    "size_bytes": f.stat().st_size,
                    "modified": f.stat().st_mtime,
                }
                for f in pdf_files
            ]
            periods.append({"period": period_dir.name, "files": files})

        if periods:
            lenders_out.append({
                "lender": lender_dir.name,
                "lender_display_name": lenders.display_name_for_folder(lender_dir.name),
                "periods": periods,
            })

    return lenders_out


def resolve_pdf_path(rel_path: str) -> Path:
    """Resolves a client-supplied relative path safely under the reports root.
    Raises ValueError if it escapes the root or isn't a PDF."""
    root = _ensure_root().resolve()
    candidate = (root / rel_path).resolve()

    if not candidate.is_relative_to(root):
        raise ValueError("Path escapes the reports root")
    if candidate.suffix.lower() != ".pdf":
        raise ValueError("Only .pdf files can be served")
    if not candidate.is_file():
        raise FileNotFoundError(rel_path)

    return candidate
