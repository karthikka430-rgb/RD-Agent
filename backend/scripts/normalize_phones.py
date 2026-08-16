"""One-time migration for phone normalization.

The application previously stored agent and customer phone numbers verbatim, so
the same mobile number could exist under several formats (9945006105,
09945006105, +919945006105) as separate accounts.

As decided, this migration starts clean: it backs up the entire database, then
removes every existing agent account and its dependent records so agents
re-register through the normalized phone handling now enforced by
validate_phone(). Run before going live on PostgreSQL.

Usage:
    python scripts/normalize_phones.py --yes   # non-interactive
    python scripts/normalize_phones.py         # asks for confirmation

Safety:
    - A full database backup is written to backend/backups/ before any change.
    - Only agent-owned data is removed; the database file itself is untouched.
"""

import argparse
import datetime
import os
import shutil
import sqlite3
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
from config import DEFAULT_DATABASE_URL  # noqa: E402


def backup_sqlite(database_url, out_path):
    source = database_url.replace("sqlite:///", "", 1)
    source = Path(source)
    if not source.exists():
        raise SystemExit(f"SQLite database not found: {source}")
    src = sqlite3.connect(str(source))
    dst = sqlite3.connect(str(out_path))
    try:
        with dst:
            src.backup(dst)
    finally:
        src.close()
        dst.close()
    print(f"Backup written to {out_path}")


def main():
    parser = argparse.ArgumentParser(description="Reset agent accounts for phone normalization.")
    parser.add_argument("--yes", action="store_true", help="Skip confirmation prompt")
    args = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL") or DEFAULT_DATABASE_URL
    if database_url.startswith("postgresql"):
        print(
            "This migration currently supports the SQLite development database only. "
            "For PostgreSQL, delete and recreate the agents manually or run the "
            "normalization queries before going live.",
            file=sys.stderr,
        )
        sys.exit(1)

    app = create_app()
    with app.app_context():
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backups_dir = BACKEND_DIR / "backups"
        backups_dir.mkdir(exist_ok=True)
        backup_path = backups_dir / f"pre-normalize-phones-{stamp}.sqlite3"
        backup_sqlite(database_url, backup_path)

        from app.models import Agent, Customer, Payment, PaymentReceipt, AuditLog, RefreshToken

        counts = {
            "agents": Agent.query.count(),
            "customers": Customer.query.count(),
            "payments": Payment.query.count(),
            "payment_receipts": PaymentReceipt.query.count(),
            "audit_logs": AuditLog.query.count(),
            "refresh_tokens": RefreshToken.query.count(),
        }
        print("Records that will be removed:", counts)

        if not args.yes:
            confirm = input("Type RESET to permanently remove these records: ").strip()
            if confirm != "RESET":
                print("Aborted. No records were changed.")
                return

        db.session.query(PaymentReceipt).delete()
        db.session.query(Payment).delete()
        db.session.query(Customer).delete()
        db.session.query(AuditLog).delete()
        db.session.query(RefreshToken).delete()
        db.session.query(Agent).delete()
        db.session.commit()

        print("All agent accounts and dependent records removed.")
        print("Agents can now re-register; phone numbers are normalized to a canonical 10-digit form.")
        print(f"Restore with: copy {backup_path} over backend/instance/rd_agent.db")


if __name__ == "__main__":
    main()