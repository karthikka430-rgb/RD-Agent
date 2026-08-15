from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import uuid4

from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import Payment, PaymentReceipt
from ..utils import ValidationError, parse_date, parse_int_in_range, parse_positive_money
from .audit_service import log_change
from .customer_service import should_be_due


def receipt_number(agent_id):
    return f"RD-{agent_id}-{datetime.now(timezone.utc):%Y%m%d}-{uuid4().hex[:8].upper()}"


def payment_payload(raw):
    if not isinstance(raw, dict):
        raise ValidationError("Each payment must be an object.")
    month = parse_int_in_range(raw.get("month"), "month", 1, 12)
    year = parse_int_in_range(raw.get("year"), "year", 2000, 2200)
    amount = parse_positive_money(raw.get("amount"), "amount")
    paid_on = parse_date(raw.get("payment_date"), "payment_date")
    if paid_on > date.today():
        raise ValidationError("Payment date cannot be in the future.", "payment_date")
    return {"month": month, "year": year, "amount": amount, "payment_date": paid_on}


def payment_receipt_history(payment):
    """Return every receipt, including a safe representation for legacy payments."""
    receipts = payment.receipts.order_by(PaymentReceipt.payment_date.asc(), PaymentReceipt.id.asc()).all()
    if receipts:
        return [receipt.public_dict() for receipt in receipts]
    # Payments recorded before partial collection support are their own original receipt.
    return [{"id": None, "amount": str(payment.amount), "payment_date": payment.payment_date.isoformat(), "receipt_number": payment.receipt_number, "legacy": True}]


def payment_collection_summary(customer, payment):
    paid_amount = Decimal("0.00") if not payment or payment.is_void else Decimal(payment.amount)
    monthly_amount = Decimal(customer.monthly_rd_amount)
    remaining_amount = max(monthly_amount - paid_amount, Decimal("0.00"))
    status = "Paid" if payment and not payment.is_void and remaining_amount == 0 else "Partial" if paid_amount else "Pending"
    data = {
        "paid_amount": str(paid_amount),
        "remaining_amount": str(remaining_amount),
        "is_paid": status == "Paid",
        "is_partial": status == "Partial",
        "status": status,
    }
    if payment:
        data["payment"] = payment.public_dict()
        data["receipts"] = payment_receipt_history(payment)
    else:
        data["payment"] = None
        data["receipts"] = []
    return data


def _backfill_legacy_receipt(agent, payment):
    """Preserve a pre-feature Payment as its first receipt before extending it."""
    if payment.receipts.count():
        return
    receipt = PaymentReceipt(
        payment_id=payment.id,
        amount=payment.amount,
        payment_date=payment.payment_date,
        receipt_number=payment.receipt_number,
    )
    db.session.add(receipt)
    db.session.flush()
    log_change(agent.id, "BACKFILL_RECEIPT", "payment_receipt", receipt.id, new_value=receipt.public_dict())


def record_payment_receipt(agent, customer, month, year, amount, payment_date):
    """Add one partial or final collection to a single monthly RD payment.

    The payment's amount is the cumulative paid total. Receipt rows are
    immutable collection events, so no cash collection is lost when a customer
    pays their installment in several parts.
    """
    if not should_be_due(customer, month, year):
        raise ValidationError("A payment period must fall within the active RD term.", "month")
    amount = parse_positive_money(amount, "amount")
    payment_date = parse_date(payment_date, "payment_date") if not isinstance(payment_date, date) else payment_date
    if payment_date > date.today():
        raise ValidationError("Payment date cannot be in the future.", "payment_date")
    expected = Decimal(customer.monthly_rd_amount)
    payment = Payment.query.filter_by(customer_id=customer.id, month=month, year=year).first()
    try:
        with db.session.begin_nested():
            if payment and not payment.is_void:
                balance = expected - Decimal(payment.amount)
                if balance <= 0:
                    raise ValidationError("This monthly RD installment is already fully paid.", "amount")
                if amount > balance:
                    raise ValidationError(f"Amount exceeds the remaining installment balance of ₹{balance:.2f}.", "amount")
                _backfill_legacy_receipt(agent, payment)
                old = payment.public_dict()
                payment.amount = Decimal(payment.amount) + amount
                db.session.flush()
                receipt = PaymentReceipt(payment_id=payment.id, amount=amount, payment_date=payment_date, receipt_number=receipt_number(agent.id))
                db.session.add(receipt)
                db.session.flush()
                log_change(agent.id, "PARTIAL_RECEIPT", "payment", payment.id, old, payment.public_dict())
                log_change(agent.id, "CREATE", "payment_receipt", receipt.id, new_value=receipt.public_dict())
                action = "completed" if payment.amount == expected else "partial"
            elif payment and payment.is_void:
                raise ValidationError("A voided payment cannot receive additional collections.")
            else:
                if amount > expected:
                    raise ValidationError(f"Amount cannot exceed the monthly RD amount of ₹{expected:.2f}.", "amount")
                receipt_no = receipt_number(agent.id)
                payment = Payment(customer_id=customer.id, month=month, year=year, amount=amount, payment_date=payment_date, receipt_number=receipt_no)
                db.session.add(payment)
                db.session.flush()
                receipt = PaymentReceipt(payment_id=payment.id, amount=amount, payment_date=payment_date, receipt_number=receipt_no)
                db.session.add(receipt)
                db.session.flush()
                log_change(agent.id, "CREATE", "payment", payment.id, new_value=payment.public_dict())
                log_change(agent.id, "CREATE", "payment_receipt", receipt.id, new_value=receipt.public_dict())
                action = "completed" if amount == expected else "partial"
        db.session.commit()
    except IntegrityError as exc:
        db.session.rollback()
        raise ValidationError("This collection was changed by another request. Refresh the register and try again.") from exc
    except Exception:
        db.session.rollback()
        raise
    return payment, receipt, action


def create_payments(agent, customer, raw_payments):
    """Create all payments atomically. Database uniqueness is the final duplicate guard."""
    if customer.status != "active":
        raise ValidationError("Payments can only be recorded for active customers.")
    if not isinstance(raw_payments, list) or not raw_payments:
        raise ValidationError("Add at least one payment.", "payments")
    if len(raw_payments) > 24:
        raise ValidationError("At most 24 payments may be recorded at once.", "payments")

    clean = [payment_payload(item) for item in raw_payments]
    periods = [(item["month"], item["year"]) for item in clean]
    if len(set(periods)) != len(periods):
        raise ValidationError("The same month cannot appear twice in one submission.", "payments")
    for item in clean:
        if not should_be_due(customer, item["month"], item["year"]):
            raise ValidationError("A payment period must fall within the active RD term.", "payments")
        if item["amount"] > Decimal(customer.monthly_rd_amount):
            raise ValidationError("A payment amount cannot exceed the monthly RD amount.", "amount")

    created = []
    try:
        with db.session.begin_nested():
            for item in clean:
                initial_receipt_number = receipt_number(agent.id)
                payment = Payment(customer_id=customer.id, receipt_number=initial_receipt_number, **item)
                db.session.add(payment)
                db.session.flush()
                log_change(agent.id, "CREATE", "payment", payment.id, new_value=payment.public_dict())
                receipt = PaymentReceipt(payment_id=payment.id, amount=payment.amount, payment_date=payment.payment_date, receipt_number=initial_receipt_number)
                db.session.add(receipt)
                db.session.flush()
                log_change(agent.id, "CREATE", "payment_receipt", receipt.id, new_value=receipt.public_dict())
                created.append(payment)
        db.session.commit()
    except IntegrityError as exc:
        db.session.rollback()
        raise ValidationError("A payment already exists for one of the selected months.", "payments") from exc
    return created


def update_payment(agent, payment, raw):
    if payment.is_void:
        raise ValidationError("Voided payments cannot be edited.")
    if payment.receipts.count():
        raise ValidationError("Recorded payment receipts are final and cannot be edited.")
    clean = payment_payload(raw)
    if not should_be_due(payment.customer, clean["month"], clean["year"]):
        raise ValidationError("A payment period must fall within the active RD term.")
    old = payment.public_dict()
    try:
        with db.session.begin_nested():
            for key, value in clean.items():
                setattr(payment, key, value)
            db.session.flush()
            log_change(agent.id, "UPDATE", "payment", payment.id, old, payment.public_dict())
        db.session.commit()
    except IntegrityError as exc:
        db.session.rollback()
        raise ValidationError("A payment already exists for this customer and month.") from exc
    return payment


def void_payment(agent, payment, reason):
    if payment.is_void:
        raise ValidationError("This payment is already voided.")
    if not isinstance(reason, str) or len(reason.strip()) < 5 or len(reason.strip()) > 500:
        raise ValidationError("A void reason of 5–500 characters is required.", "reason")
    old = payment.public_dict()
    with db.session.begin_nested():
        payment.voided_at = datetime.now(timezone.utc)
        payment.void_reason = reason.strip()
        db.session.flush()
        log_change(agent.id, "VOID", "payment", payment.id, old, payment.public_dict())
    db.session.commit()
    return payment


def _reconcile_receipts(agent, payment, receipts, new_amount, new_date):
    """Keep the receipt trail equal to the corrected collection total.

    Adjusts from the most recent receipt backwards so earlier collection history
    is preserved as much as possible; any receipt reduced to zero is removed and
    every change is audit logged.
    """
    ordered = list(receipts)
    while len(ordered) > 1:
        total_other = sum((Decimal(receipt.amount) for receipt in ordered[:-1]), Decimal("0.00"))
        if new_amount - total_other > Decimal("0.00"):
            break
        dropped = ordered.pop()
        old_receipt = dropped.public_dict()
        db.session.delete(dropped)
        log_change(agent.id, "CORRECT_COLLECTION", "payment_receipt", dropped.id, old_receipt, None)
    last = ordered[-1]
    last_expected = new_amount - sum((Decimal(receipt.amount) for receipt in ordered[:-1]), Decimal("0.00"))
    if Decimal(last.amount) != last_expected or last.payment_date != new_date:
        old_receipt = last.public_dict()
        last.amount = last_expected
        last.payment_date = new_date
        db.session.flush()
        log_change(agent.id, "CORRECT_COLLECTION", "payment_receipt", last.id, old_receipt, last.public_dict())


def correct_collection(agent, payment, raw):
    """Correct an accidentally recorded collection.

    The paid toggle stays final; this only adjusts the recorded amount and
    collection date of an already-collected installment. The previous value is
    preserved in the audit log, and the aggregate payment is kept equal to the
    sum of its receipts so balances, reports, and backups stay consistent.
    """
    if payment.is_void:
        raise ValidationError("A voided collection cannot be edited.")
    if not isinstance(raw, dict):
        raise ValidationError("Request body must be a JSON object.")
    reason = raw.get("reason")
    if not isinstance(reason, str) or len(reason.strip()) < 5 or len(reason.strip()) > 500:
        raise ValidationError("A correction reason of 5–500 characters is required.", "reason")
    new_amount = parse_positive_money(raw.get("amount"), "amount")
    new_date = parse_date(raw.get("payment_date"), "payment_date")
    if new_date > date.today():
        raise ValidationError("Payment date cannot be in the future.", "payment_date")
    expected = Decimal(payment.customer.monthly_rd_amount)
    if new_amount > expected:
        raise ValidationError(f"Amount cannot exceed the monthly RD amount of ₹{expected:.2f}.", "amount")
    old = payment.public_dict()
    receipts = payment.receipts.order_by(PaymentReceipt.payment_date.asc(), PaymentReceipt.id.asc()).all()
    with db.session.begin_nested():
        if receipts:
            _reconcile_receipts(agent, payment, receipts, new_amount, new_date)
        else:
            receipt = PaymentReceipt(payment_id=payment.id, amount=new_amount, payment_date=new_date, receipt_number=receipt_number(agent.id))
            db.session.add(receipt)
            db.session.flush()
            log_change(agent.id, "CORRECT_COLLECTION", "payment_receipt", receipt.id, new_value=receipt.public_dict())
        payment.amount = new_amount
        payment.payment_date = new_date
        db.session.flush()
        log_change(agent.id, "CORRECT_COLLECTION", "payment", payment.id, old, payment.public_dict())
    db.session.commit()
    return payment
