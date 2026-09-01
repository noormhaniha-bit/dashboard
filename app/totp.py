"""TOTP two-factor auth (Google Authenticator / Authy / any RFC 6238 app). Standard library
of the space: pyotp for the code math, qrcode to render the enrollment QR as a PNG the
browser can show inline as a data URI -- no external QR-rendering service involved.
"""

import base64
from io import BytesIO

import pyotp
import qrcode

ISSUER_NAME = "Ops Dashboard"


def generate_secret() -> str:
    return pyotp.random_base32()


def provisioning_uri(secret: str, email: str) -> str:
    return pyotp.totp.TOTP(secret).provisioning_uri(name=email, issuer_name=ISSUER_NAME)


def qr_code_data_uri(uri: str) -> str:
    img = qrcode.make(uri)
    buf = BytesIO()
    img.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def verify_code(secret: str, code: str) -> bool:
    # valid_window=1 tolerates the code from one 30s step before/after, for clock drift --
    # without it, a code typed a couple seconds late fails for no good reason.
    return pyotp.TOTP(secret).verify(code, valid_window=1)
