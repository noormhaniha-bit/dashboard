"""The business-facing list of lenders, as given by the team -- used to seed the admin
access-grant UI (so an admin can grant a lender before its first report ever lands) and to
label PDF report folders with their real name instead of the on-disk folder slug.

Folder names on disk (from the Zendesk export naming convention) don't always match the
business name 1:1 -- only the differences need an override; anything not listed here is
assumed to match exactly (e.g. "FECI", "AGOS", "CACF").
"""

import re

CANONICAL_LENDERS = [
    "Citizens",
    "FECI",
    "Floa",
    "Huntington",
    "Ikano / Nets",
    "JDF",
    "RBC",
    "Seattle Bank",
    "IKEA IE",
    "AGOS",
    "CACF",
    "Caixa Bank",
    "Barclays",
    "BuyWay",
]

_FOLDER_OVERRIDES = {
    "Floa": "FLOA",
    "Ikano / Nets": "IKANO",
    "IKEA IE": "IKEA-IE",
    "Caixa Bank": "CAIXA",
}

_DISPLAY_OVERRIDES = {folder: canonical for canonical, folder in _FOLDER_OVERRIDES.items()}


def folder_name_for(canonical_name: str) -> str:
    return _FOLDER_OVERRIDES.get(canonical_name, canonical_name)


def display_name_for_folder(folder_name: str) -> str:
    return _DISPLAY_OVERRIDES.get(folder_name, folder_name)


def slug_for(canonical_name: str) -> str:
    """URL-safe identifier for a lender's own page (/lender/<slug>) -- needed because a
    canonical name can contain characters that don't belong in a path segment, e.g.
    "Ikano / Nets"."""
    return re.sub(r"[^a-z0-9]+", "-", canonical_name.lower()).strip("-")


CANONICAL_LENDERS_BY_SLUG = {slug_for(name): name for name in CANONICAL_LENDERS}
