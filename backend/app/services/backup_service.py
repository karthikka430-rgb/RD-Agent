"""Agent-scoped backup creation and safe merge-only restoration."""

import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import BackupSnapshot, Customer, Payment, PaymentReceipt
from ..utils import ValidationError
from .audit_service import log_change
from .customer_service import customer_from_payload
from .payment_service import payment_payload, payment_receipt_history, receipt_number


BACKUP_FORMAT = "rd-agent-management-backup"
BACKUP_VERSION = 2


def agent_backup_payload(agent):
    """Create a complete portable snapshot without exposing an external file."""
    customers = Customer.query.filter_by(agent_id=agent.id).order_by(Customer.id).all()
    customer_records = []
    payment_count = 0
    receipt_count = 0
    for customer in customers:
        record = customer.public_dict()
        record.pop("agent_id", None)
        record["payments"] = []
        for payment in customer.payments.order_by(Payment.id):
            payment_record = payment.public_dict()
            receipts = payment_receipt_history(payment)
            payment_record["receipts"] = receipts
            record["payments"].append(payment_record)
            payment_count += 1
            receipt_count += len(receipts)
        customer_records.append(record)
    return {
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "agent": agent.public_dict(),
        "customers": customer_records,
    }, len(customer_records), payment_count, receipt_count


def _payload_hash(payload):
    """Hash financial content, excluding only the generated snapshot time."""
    stable_payload = {key: value for key, value in payload.items() if key != "exported_at"}
    encoded = json.dumps(stable_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def create_internal_backup(agent, trigger="automatic"):
    """Save a new agent-private snapshot only when financial data changed."""
    if trigger not in {"automatic", "manual"}:
        raise ValidationError("Invalid backup trigger.")
    payload, customer_count, payment_count, receipt_count = agent_backup_payload(agent)
    content_hash = _payload_hash(payload)
    existing = BackupSnapshot.query.filter_by(agent_id=agent.id, content_hash=content_hash).first()
    if existing:
        return existing, False
    try:
        with db.session.begin_nested():
            snapshot = BackupSnapshot(
                agent_id=agent.id,
                trigger=trigger,
                content_hash=content_hash,
                payload=json.dumps(payload, sort_keys=True),
                customer_count=customer_count,
                payment_count=payment_count,
                receipt_count=receipt_count,
            )
            db.session.add(snapshot)
            db.session.flush()
            action = "AUTO_BACKUP" if trigger == "automatic" else "MANUAL_BACKUP"
            log_change(agent.id, action, "backup_snapshot", snapshot.id, new_value=snapshot.public_dict())
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        # A concurrent online client created the identical snapshot first.
        existing = BackupSnapshot.query.filter_by(agent_id=agent.id, content_hash=content_hash).first()
        if existing:
            return existing, False
        raise
    return snapshot, True


def parse_backup_payload(raw):
    if not isinstance(raw, dict):
        raise ValidationError("Backup data is invalid.", "backup")
    if raw.get("format") != BACKUP_FORMAT or raw.get("version") not in {1, BACKUP_VERSION}:
        raise ValidationError("This is not a supported RD Agent backup.", "backup")
    records = raw.get("customers")
    if not isinstance(records, list) or len(records) > 10000:
        raise ValidationError("Backup customer data is invalid.", "backup")
    return records


def restore_backup_payload(agent, raw):
    """Merge a snapshot into the current agent account without overwriting data."""
    records = parse_backup_payload(raw)
    imported_customers = imported_payments = skipped_customers = skipped_payments = 0
    try:
        with db.session.begin_nested():
            for raw_customer in records:
                if not isinstance(raw_customer, dict):
                    raise ValidationError("Backup contains an invalid customer.", "backup")
                values = customer_from_payload(
                    {
                        **raw_customer,
                        "status": raw_customer.get("status", "active") if raw_customer.get("status") != "archived" else "closed",
                    }
                )
                existing = Customer.query.filter_by(agent_id=agent.id, account_number=values["account_number"]).first()
                if existing:
                    customer = existing
                    skipped_customers += 1
                else:
                    customer = Customer(agent_id=agent.id, **values)
                    if raw_customer.get("status") == "archived":
                        customer.status = "archived"
                    db.session.add(customer)
                    db.session.flush()
                    log_change(agent.id, "RESTORE_CREATE", "customer", customer.id, new_value=customer.public_dict())
                    imported_customers += 1

                raw_payments = raw_customer.get("payments", [])
                if not isinstance(raw_payments, list):
                    raise ValidationError("Backup contains invalid payments.", "backup")
                for raw_payment in raw_payments:
                    clean = payment_payload(raw_payment)
                    exists = Payment.query.filter_by(customer_id=customer.id, month=clean["month"], year=clean["year"]).first()
                    if exists:
                        skipped_payments += 1
                        continue
                    raw_receipts = raw_payment.get("receipts")
                    if raw_receipts is not None and (not isinstance(raw_receipts, list) or not raw_receipts):
                        raise ValidationError("Backup contains invalid payment receipts.", "backup")
                    # Older backups have no receipt collection, so their original
                    # payment is recreated as one immutable receipt.
                    receipt_items = raw_receipts or [{"amount": str(clean["amount"]), "payment_date": clean["payment_date"].isoformat()}]
                    clean_receipts = []
                    for raw_receipt in receipt_items:
                        if not isinstance(raw_receipt, dict):
                            raise ValidationError("Backup contains invalid payment receipts.", "backup")
                        clean_receipts.append(
                            payment_payload(
                                {
                                    "month": clean["month"],
                                    "year": clean["year"],
                                    "amount": raw_receipt.get("amount"),
                                    "payment_date": raw_receipt.get("payment_date"),
                                }
                            )
                        )
                    if sum((item["amount"] for item in clean_receipts), Decimal("0.00")) != clean["amount"]:
                        raise ValidationError("Backup receipt amounts do not equal the saved payment total.", "backup")

                    generated_receipts = [receipt_number(agent.id) for _ in clean_receipts]
                    payment = Payment(customer_id=customer.id, receipt_number=generated_receipts[0], **clean)
                    if raw_payment.get("voided_at"):
                        payment.voided_at = datetime.now(timezone.utc)
                        payment.void_reason = "Imported as voided from backup"
                    db.session.add(payment)
                    db.session.flush()
                    log_change(agent.id, "RESTORE_CREATE", "payment", payment.id, new_value=payment.public_dict())
                    for receipt_item, receipt_no in zip(clean_receipts, generated_receipts):
                        receipt = PaymentReceipt(
                            payment_id=payment.id,
                            amount=receipt_item["amount"],
                            payment_date=receipt_item["payment_date"],
                            receipt_number=receipt_no,
                        )
                        db.session.add(receipt)
                        db.session.flush()
                        log_change(agent.id, "RESTORE_CREATE", "payment_receipt", receipt.id, new_value=receipt.public_dict())
                    imported_payments += 1
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise
    return {
        "imported_customers": imported_customers,
        "imported_payments": imported_payments,
        "skipped_customers": skipped_customers,
        "skipped_payments": skipped_payments,
    }
