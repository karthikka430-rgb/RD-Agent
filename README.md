# RD Agent Management System

A Flask and vanilla JavaScript application for Post Office RD agents. The system keeps each agent's customers and financial records isolated, and is designed around financial-data integrity.

## What is included

- Agent registration with name, phone, optional email, and password; phone-number login with Werkzeug password hashing, secure session settings, session fixation prevention, and CSRF protection for every state-changing request. The signed-in agent can edit their own profile, with edits audit logged.
- Agent-scoped customer and payment queries: a signed-in agent receives a `404` for another agent's customer or payment.
- Database-enforced unique account number per agent and unique payment period per customer; payment batches use a transaction so a partial batch cannot be saved.
- A partial-payment ledger: every customer/month has one protected installment balance, while every amount received has its own immutable receipt number, date, and audit entry. The register, pending list, customer history, dashboard, and reports show the amount paid and the amount still remaining.
- Financial records are not deleted. Customer deletion is an archive action, and a payment marked paid is final: it cannot be unchecked or voided. Every creation, edit, archive, and restoration is audit logged.
- Monthly, customer-wise, and pending reports with Excel and PDF exports. The Collection Register is a monthly sheet of Active customers whose RD term overlaps the selected month; each eligible row is Pending until its unique payment is fully collected. Future/pre-paid months inside the RD term are supported, but months before the start or after maturity are excluded.
- Automatic, agent-private internal backups. When the browser is online, changed records are snapshotted inside the application database without creating a download; identical data is not saved again. The in-app restore is merge-only, preserves partial-payment receipts, never overwrites or removes current records, and skips duplicate accounts or installments.

## Project layout

```
backend/
  app/                 Flask factory, blueprints, models, services, utilities
  scripts/seed.py      Non-destructive demo-data creator
  tests/               Financial integrity tests
  schema.sql           Database reference schema
  config.py            Environment-based configuration
frontend/
  index.html           Responsive single-page workspace
  assets/              CSS and vanilla JavaScript API client
```

## Run locally

Requires Python 3.10+.

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env  # then set a long random SECRET_KEY
python run.py
```

Open `http://127.0.0.1:5000`, create an agent account, and sign in.

Local development uses SQLite by default (`backend/instance/rd_agent.db`). Production must set `DATABASE_URL` to PostgreSQL — see [Permanent storage](#permanent-storage-postgresql).

Phone numbers are normalized to a canonical 10-digit form at registration, login, and profile updates, so `9945006105`, `09945006105`, and `+919945006105` are the same account. Existing pre-normalization databases may need the reset script: `python scripts\normalize_phones.py --yes` (backs up to `backend/backups/` first, then removes all agent accounts so agents re-register).

For representative demo data:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python scripts\seed.py
```

Demo credentials are `98765 43210` / `ChangeMeDemo123!`. Change or remove these in any real deployment.

## Verification

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
pytest -q
```

The included tests verify cross-agent isolation, database-backed duplicate-payment prevention, partial-payment balances and receipts, automatic-backup deduplication, backup privacy, final-payment enforcement, and audit logging.

## Production deployment notes

- Set a cryptographically random `SECRET_KEY`; set `SESSION_COOKIE_SECURE=true` behind HTTPS.
- Run Flask behind a production WSGI server such as Waitress or Gunicorn and place it behind a reverse proxy with TLS.
- The models use portable SQLAlchemy types and constraints. Set `DATABASE_URL` to a PostgreSQL SQLAlchemy URL and introduce Alembic migrations before a PostgreSQL rollout.
- Internal snapshots protect against accidental in-app changes but reside in the same application database. For protection against server, disk, or database loss, secure the application database with infrastructure-level backups and restrict storage access.
- Add rate limiting, password reset/email verification, centralized logging, and a separately authorized administrator role if deployed for a multi-agent organization.

### Permanent storage (PostgreSQL)

Production data **must not** live in the SQLite file under `backend/instance/`, which on hosting platforms such as Render sits on ephemeral disk and is wiped on every redeploy. Instead:

1. Provision a PostgreSQL database (Render Managed Postgres is a good fit).
2. Set `DATABASE_URL` in the hosting environment, for example `postgres://USER:PASSWORD@HOST:5432/DBNAME`. Render/Heroku's `postgres://` scheme is automatically normalized to the SQLAlchemy-compatible `postgresql+psycopg://` at startup.
3. On first boot the application creates all tables from the models (`db.create_all()`). The tables are portable: `agents`, `customers`, `payments`, `payment_receipts`, `audit_logs`, `backup_snapshots`, `refresh_tokens`.
4. The startup log prints the active engine. If it prints `Using SQLite (...)`, production is still on ephemeral storage — fix `DATABASE_URL` before entering real data.

Run checks:

```powershell
cd backend
python scripts\backup_db.py --verify     # confirms connectivity and record counts
```

### Backups and recovery plan

- **Application-level backups:** the built-in "Backup & restore" screen stores agent-private JSON snapshots inside the database and is merge-only (it never overwrites or deletes financial records). These are convenient but live in the same database.
- **Infrastructure-level backups (required):** take consistent dumps of the whole PostgreSQL database on a schedule.

Back up the database:

```powershell
cd backend
# PostgreSQL (production):
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME python scripts\backup_db.py --verify
# Local SQLite (development only):
python scripts\backup_db.py --verify
```

`backup_db.py` writes a custom-format dump to `backend/backups/` (PostgreSQL via `pg_dump`, SQLite via a consistent online copy). Store the resulting files off the application server (object storage, another machine).

Recovery:

- **PostgreSQL:** `pg_restore --clean --if-exists --dbname <DATABASE_URL> <backup-file>` — restore the whole database, then confirm with `python scripts\backup_db.py --verify`.
- **SQLite (development only):** copy the `.sqlite3` backup over `backend/instance/rd_agent.db`.
- **Application-level restore:** on the "Backup & restore" screen, restore an internal snapshot; duplicate accounts and installments are skipped, existing records are untouched.

### No-data-loss deployment checklist

1. Confirm `DATABASE_URL` points to PostgreSQL and the startup log says `Active database engine: postgresql`.
2. Take a backup (`python scripts\backup_db.py`) before any deploy or schema change.
3. Deploy new code — `db.create_all()` is additive and never drops or resets tables.
4. After deploy, run `python scripts\backup_db.py --verify` and confirm agent/customer counts are unchanged.

## Financial-data behavior

The unique payment period constraint guarantees one installment record per customer/month/year. Its `amount` is the cumulative collection total, never a duplicate month entry. Each cash collection is stored as an immutable receipt row, so a ₹500 monthly RD can safely be recorded as ₹300 plus ₹200. A fully paid payment cannot be unchecked or voided. Any allowed correction preserves the previous value in the audit log, ensuring the system cannot silently create a second record for the same customer/month/year.
