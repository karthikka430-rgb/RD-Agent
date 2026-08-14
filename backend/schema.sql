-- SQLite reference schema. SQLAlchemy models in app/models.py are the source of truth.
-- Uses portable types and constraints so a PostgreSQL migration can retain this design.
PRAGMA foreign_keys = ON;

CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(30) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  customer_name VARCHAR(160) NOT NULL,
  account_number VARCHAR(64) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  monthly_rd_amount NUMERIC(12,2) NOT NULL CHECK(monthly_rd_amount > 0),
  start_date DATE NOT NULL,
  maturity_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  archived_at DATETIME,
  CONSTRAINT uq_customer_agent_account UNIQUE(agent_id, account_number)
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12),
  year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 2200),
  amount NUMERIC(12,2) NOT NULL CHECK(amount > 0),
  payment_date DATE NOT NULL,
  receipt_number VARCHAR(64) NOT NULL UNIQUE,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  voided_at DATETIME,
  void_reason VARCHAR(500),
  CONSTRAINT uq_payment_customer_period UNIQUE(customer_id, month, year)
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id INTEGER NOT NULL,
  old_value TEXT,
  new_value TEXT,
  timestamp DATETIME NOT NULL
);

CREATE TABLE payment_receipts (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  amount NUMERIC(12,2) NOT NULL CHECK(amount > 0),
  payment_date DATE NOT NULL,
  receipt_number VARCHAR(64) NOT NULL UNIQUE,
  created_at DATETIME NOT NULL
);

CREATE TABLE backup_snapshots (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  trigger VARCHAR(20) NOT NULL DEFAULT 'automatic',
  content_hash VARCHAR(64) NOT NULL,
  payload TEXT NOT NULL,
  customer_count INTEGER NOT NULL DEFAULT 0,
  payment_count INTEGER NOT NULL DEFAULT 0,
  receipt_count INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  CONSTRAINT uq_backup_snapshot_agent_content UNIQUE(agent_id, content_hash)
);

CREATE INDEX ix_customers_agent_status ON customers(agent_id, status);
CREATE INDEX ix_payments_period ON payments(year, month);
CREATE INDEX ix_audit_agent_entity ON audit_logs(agent_id, entity_type, entity_id);
CREATE INDEX ix_payment_receipts_payment ON payment_receipts(payment_id);
CREATE INDEX ix_backup_snapshots_agent_created ON backup_snapshots(agent_id, created_at);
