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

## Financial-data behavior

The unique payment period constraint guarantees one installment record per customer/month/year. Its `amount` is the cumulative collection total, never a duplicate month entry. Each cash collection is stored as an immutable receipt row, so a ₹500 monthly RD can safely be recorded as ₹300 plus ₹200. A fully paid payment cannot be unchecked or voided. Any allowed correction preserves the previous value in the audit log, ensuring the system cannot silently create a second record for the same customer/month/year.
