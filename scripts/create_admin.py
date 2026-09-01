#!/usr/bin/env python3
"""Create (or promote/reset) an admin user for the SLA dashboard.

Run from the project root: python -m scripts.create_admin you@jifiti.com
Prompts for the password interactively -- never pass it as a command-line argument, since
that would end up in shell history and process listings.
"""

import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import SessionLocal, init_db  # noqa: E402
from app.models import User, UserRole  # noqa: E402
from app.security import hash_password  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Create or promote an admin user")
    parser.add_argument("email")
    args = parser.parse_args()

    password = getpass.getpass("Password: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Passwords do not match.")
        sys.exit(1)
    if len(password) < 8:
        print("Use at least 8 characters.")
        sys.exit(1)

    init_db()
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == args.email).first()
        if user:
            user.hashed_password = hash_password(password)
            user.role = UserRole.ADMIN
            user.is_active = True
            print(f"Updated existing user {args.email} -> admin, password reset.")
        else:
            user = User(email=args.email, hashed_password=hash_password(password), role=UserRole.ADMIN)
            db.add(user)
            print(f"Created admin user {args.email}.")
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
