from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import uuid4

from werkzeug.security import check_password_hash, generate_password_hash

from .extensions import db


PRIVATE_EMAIL_DOMAIN = "rd-agent.local.invalid"


def private_email_placeholder():
    """Unique non-routable storage value for an agent who elects not to add email.

    Keeping a value rather than NULL also supports existing SQLite deployments
    created before email was optional, whose column is NOT NULL.
    """
    return f"agent-{uuid4().hex}@{PRIVATE_EMAIL_DOMAIN}"


def is_private_email(value):
    return bool(value and value.lower().endswith(f"@{PRIVATE_EMAIL_DOMAIN}"))


def utcnow():
    return datetime.now(timezone.utc)


class SerializerMixin:
    def as_dict(self):
        return {column.name: self._serialize(getattr(self, column.name)) for column in self.__table__.columns}

    @staticmethod
    def _serialize(value):
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, date):
            return value.isoformat()
        if isinstance(value, Decimal):
            return str(value)
        return value


class Agent(db.Model, SerializerMixin):
    __tablename__ = "agents"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    # Agent phone numbers identify login accounts; email remains contact/recovery data.
    phone = db.Column(db.String(30), nullable=False, unique=True, index=True)
    email = db.Column(db.String(255), nullable=False, unique=True, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    customers = db.relationship("Customer", back_populates="agent", lazy="dynamic")

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def public_dict(self):
        return {"id": self.id, "name": self.name, "phone": self.phone, "email": None if is_private_email(self.email) else self.email}


class Customer(db.Model, SerializerMixin):
    __tablename__ = "customers"
    __table_args__ = (
        db.UniqueConstraint("agent_id", "account_number", name="uq_customer_agent_account"),
        db.Index("ix_customers_agent_status", "agent_id", "status"),
    )

    id = db.Column(db.Integer, primary_key=True)
    agent_id = db.Column(db.Integer, db.ForeignKey("agents.id"), nullable=False, index=True)
    customer_name = db.Column(db.String(160), nullable=False)
    account_number = db.Column(db.String(64), nullable=False)
    phone = db.Column(db.String(30), nullable=False)
    monthly_rd_amount = db.Column(db.Numeric(12, 2), nullable=False)
    start_date = db.Column(db.Date, nullable=False)
    maturity_date = db.Column(db.Date, nullable=False)
    status = db.Column(db.String(20), nullable=False, default="active")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    archived_at = db.Column(db.DateTime(timezone=True), nullable=True)

    agent = db.relationship("Agent", back_populates="customers")
    payments = db.relationship("Payment", back_populates="customer", lazy="dynamic")

    def public_dict(self):
        data = self.as_dict()
        data["monthly_rd_amount"] = str(self.monthly_rd_amount)
        return data


class Payment(db.Model, SerializerMixin):
    __tablename__ = "payments"
    __table_args__ = (
        # A payment is never deleted. Corrections update the original record and remain auditable.
        db.UniqueConstraint("customer_id", "month", "year", name="uq_payment_customer_period"),
        db.UniqueConstraint("receipt_number", name="uq_payment_receipt"),
        db.CheckConstraint("month >= 1 AND month <= 12", name="ck_payment_month"),
        db.CheckConstraint("year >= 2000 AND year <= 2200", name="ck_payment_year"),
        db.CheckConstraint("amount > 0", name="ck_payment_amount_positive"),
        db.Index("ix_payments_period", "year", "month"),
    )

    id = db.Column(db.Integer, primary_key=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("customers.id"), nullable=False, index=True)
    month = db.Column(db.Integer, nullable=False)
    year = db.Column(db.Integer, nullable=False)
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    payment_date = db.Column(db.Date, nullable=False)
    receipt_number = db.Column(db.String(64), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    voided_at = db.Column(db.DateTime(timezone=True), nullable=True)
    void_reason = db.Column(db.String(500), nullable=True)

    customer = db.relationship("Customer", back_populates="payments")
    receipts = db.relationship("PaymentReceipt", back_populates="payment", lazy="dynamic")

    @property
    def is_void(self):
        return self.voided_at is not None

    def public_dict(self):
        data = self.as_dict()
        data["amount"] = str(self.amount)
        data["is_void"] = self.is_void
        return data


class PaymentReceipt(db.Model, SerializerMixin):
    """An immutable cash collection contributing to one customer's monthly RD."""
    __tablename__ = "payment_receipts"
    __table_args__ = (
        db.UniqueConstraint("receipt_number", name="uq_payment_receipt_number"),
        db.CheckConstraint("amount > 0", name="ck_payment_receipt_amount_positive"),
        db.Index("ix_payment_receipts_payment", "payment_id"),
    )

    id = db.Column(db.Integer, primary_key=True)
    payment_id = db.Column(db.Integer, db.ForeignKey("payments.id"), nullable=False, index=True)
    amount = db.Column(db.Numeric(12, 2), nullable=False)
    payment_date = db.Column(db.Date, nullable=False)
    receipt_number = db.Column(db.String(64), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    payment = db.relationship("Payment", back_populates="receipts")

    def public_dict(self):
        data = self.as_dict()
        data["amount"] = str(self.amount)
        return data


class BackupSnapshot(db.Model, SerializerMixin):
    """An agent-private, internal restore point.

    Snapshots are intentionally kept separate from financial records. They are
    never exposed as files by the application UI and contain only the signed-in
    agent's public profile, customers, installments, and receipt history.
    """

    __tablename__ = "backup_snapshots"
    __table_args__ = (
        db.UniqueConstraint("agent_id", "content_hash", name="uq_backup_snapshot_agent_content"),
        db.Index("ix_backup_snapshots_agent_created", "agent_id", "created_at"),
    )

    id = db.Column(db.Integer, primary_key=True)
    agent_id = db.Column(db.Integer, db.ForeignKey("agents.id"), nullable=False, index=True)
    trigger = db.Column(db.String(20), nullable=False, default="automatic")
    content_hash = db.Column(db.String(64), nullable=False)
    payload = db.Column(db.Text, nullable=False)
    customer_count = db.Column(db.Integer, nullable=False, default=0)
    payment_count = db.Column(db.Integer, nullable=False, default=0)
    receipt_count = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    def public_dict(self):
        return {
            "id": self.id,
            "trigger": self.trigger,
            "customer_count": self.customer_count,
            "payment_count": self.payment_count,
            "receipt_count": self.receipt_count,
            "created_at": self.created_at.isoformat(),
        }


class RefreshToken(db.Model, SerializerMixin):
    """A long-lived device credential used only to restore a Flask session.

    Only the SHA-256 hash of the raw token is stored. Tokens are never exposed
    to business routes and are revoked on explicit logout or rotation.
    """

    __tablename__ = "refresh_tokens"
    __table_args__ = (db.Index("ix_refresh_tokens_agent", "agent_id"),)

    id = db.Column(db.Integer, primary_key=True)
    agent_id = db.Column(db.Integer, db.ForeignKey("agents.id"), nullable=False, index=True)
    token_hash = db.Column(db.String(64), nullable=False, unique=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    last_used_at = db.Column(db.DateTime(timezone=True), nullable=True)
    revoked_at = db.Column(db.DateTime(timezone=True), nullable=True)

    def public_dict(self):
        return {
            "id": self.id,
            "agent_id": self.agent_id,
            "created_at": self.created_at.isoformat(),
            "last_used_at": self.last_used_at.isoformat() if self.last_used_at else None,
            "revoked_at": self.revoked_at.isoformat() if self.revoked_at else None,
        }


class AuditLog(db.Model, SerializerMixin):
    __tablename__ = "audit_logs"
    __table_args__ = (db.Index("ix_audit_agent_entity", "agent_id", "entity_type", "entity_id"),)

    id = db.Column(db.Integer, primary_key=True)
    agent_id = db.Column(db.Integer, db.ForeignKey("agents.id"), nullable=False, index=True)
    action = db.Column(db.String(80), nullable=False)
    entity_type = db.Column(db.String(80), nullable=False)
    entity_id = db.Column(db.Integer, nullable=False)
    old_value = db.Column(db.Text, nullable=True)
    new_value = db.Column(db.Text, nullable=True)
    timestamp = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
