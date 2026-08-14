"""Create a consistent database backup.

Supports PostgreSQL (pg_dump) for production and SQLite for local development.

Usage:
    python scripts/backup_db.py                # uses DATABASE_URL (or default dev SQLite)
    python scripts/backup_db.py --out path     # write the backup to a specific file
    python scripts/backup_db.py --verify       # print record counts after backing up

Restore:
    PostgreSQL:  pg_restore --clean --if-exists --dbname <DATABASE_URL> <file>
    SQLite:      copy the .sqlite3 file over backend/instance/rd_agent.db
"""

import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from config import DEFAULT_DATABASE_URL, normalize_database_url  # noqa: E402


def sqlite_backup_path(database_url):
    path = database_url.replace("sqlite:///", "", 1)
    return Path(path)


def backup_sqlite(database_url, out_path):
    source = sqlite_backup_path(database_url)
    if not source.exists():
        print(f"SQLite database not found: {source}", file=sys.stderr)
        sys.exit(1)
    # Use the sqlite3 online backup API for a consistent copy even while the app runs.
    src = sqlite3.connect(str(source))
    dst = sqlite3.connect(str(out_path))
    try:
        with dst:
            src.backup(dst)
    finally:
        src.close()
        dst.close()
    print(f"SQLite backup written to {out_path}")


def pg_env(database_url):
    parts = urlsplit(database_url)
    env = dict(os.environ)
    if parts.username:
        env["PGUSER"] = parts.username
    if parts.password:
        env["PGPASSWORD"] = parts.password
    if parts.hostname:
        env["PGHOST"] = parts.hostname
    if parts.port:
        env["PGPORT"] = str(parts.port)
    env["PGDATABASE"] = parts.path.lstrip("/")
    return env


def backup_postgres(database_url, out_path, format_="custom"):
    env = pg_env(database_url)
    command = [
        "pg_dump",
        f"--format={format_}",
        "--no-owner",
        "--no-privileges",
        "--verbose",
    ]
    if format_ == "custom":
        command.append(f"--file={out_path}")
    print(f"Running pg_dump -> {out_path}")
    subprocess.run(command, env=env, check=True)
    print(f"PostgreSQL backup written to {out_path}")


def count_records(database_url):
    if database_url.startswith("postgresql"):
        parts = urlsplit(database_url)
        env = pg_env(database_url)
        dbname = parts.path.lstrip("/")
        command = [
            "psql",
            "-d",
            dbname,
            "-Atc",
            "SELECT 'agents=' || count(*) FROM agents UNION ALL "
            "SELECT 'customers=' || count(*) FROM customers UNION ALL "
            "SELECT 'payments=' || count(*) FROM payments UNION ALL "
            "SELECT 'payment_receipts=' || count(*) FROM payment_receipts UNION ALL "
            "SELECT 'refresh_tokens=' || count(*) FROM refresh_tokens UNION ALL "
            "SELECT 'backup_snapshots=' || count(*) FROM backup_snapshots;",
        ]
        result = subprocess.run(command, env=env, capture_output=True, text=True, check=True)
        print(result.stdout.strip())
    else:
        path = sqlite_backup_path(database_url)
        conn = sqlite3.connect(str(path))
        try:
            for table in ("agents", "customers", "payments", "payment_receipts", "refresh_tokens", "backup_snapshots"):
                try:
                    count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                except sqlite3.OperationalError:
                    count = "n/a"
                print(f"{table}={count}")
        finally:
            conn.close()


def main():
    parser = argparse.ArgumentParser(description="Back up the application database.")
    parser.add_argument("--out", default=None, help="Output file path (default: backups/<timestamp>.<ext>)")
    parser.add_argument("--verify", action="store_true", help="Print record counts after backing up")
    args = parser.parse_args()

    database_url = normalize_database_url(os.environ.get("DATABASE_URL") or DEFAULT_DATABASE_URL)
    is_postgres = database_url.startswith("postgresql")

    backups_dir = BACKEND_DIR / "backups"
    backups_dir.mkdir(exist_ok=True)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        import datetime

        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        out_path = backups_dir / (f"rd-agent-{stamp}.backup" if is_postgres else f"rd-agent-{stamp}.sqlite3")

    if is_postgres:
        backup_postgres(database_url, out_path)
    else:
        backup_sqlite(database_url, out_path)

    if args.verify:
        print("Verification counts:")
        count_records(database_url)

    print(f"\nBackup complete: {out_path}")
    if is_postgres:
        print(f"Restore: pg_restore --clean --if-exists --dbname <DATABASE_URL> {out_path}")


if __name__ == "__main__":
    main()