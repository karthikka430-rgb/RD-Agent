from decimal import Decimal

from sqlalchemy import func

from ..models import Customer, Payment
from .customer_service import active_collection_customers_query
from .payment_service import payment_collection_summary, payment_receipt_history


def monthly_report(agent_id, month, year):
    """One row per monthly installment, including its paid and remaining totals."""
    payments = (
        Payment.query.join(Customer)
        .filter(Customer.agent_id == agent_id, Payment.month == month, Payment.year == year)
        .order_by(Customer.customer_name.asc())
        .all()
    )
    rows = []
    total = Decimal("0.00")
    receipt_count = 0
    for payment in payments:
        summary = payment_collection_summary(payment.customer, payment)
        receipts = payment_receipt_history(payment)
        rows.append(
            {
                "customer_name": payment.customer.customer_name,
                "account_number": payment.customer.account_number,
                "phone": payment.customer.phone,
                "monthly_rd_amount": str(payment.customer.monthly_rd_amount),
                "paid_amount": summary["paid_amount"],
                "remaining_amount": summary["remaining_amount"],
                "receipts": "; ".join(
                    f"{receipt['receipt_number']} (Rs. {receipt['amount']} on {receipt['payment_date']})"
                    for receipt in receipts
                ),
                "status": "Voided" if payment.is_void else summary["status"],
            }
        )
        if not payment.is_void:
            total += Decimal(payment.amount)
            receipt_count += len(receipts)
    columns = [
        "customer_name",
        "account_number",
        "phone",
        "monthly_rd_amount",
        "paid_amount",
        "remaining_amount",
        "receipts",
        "status",
    ]
    return {
        "title": f"Monthly collection - {month:02d}/{year}",
        "columns": columns,
        "rows": rows,
        "summary": {
            "installment_count": len([payment for payment in payments if not payment.is_void]),
            "receipt_count": receipt_count,
            "collection": str(total),
        },
    }


def customer_report(agent_id):
    customers = Customer.query.filter_by(agent_id=agent_id).order_by(Customer.customer_name.asc()).all()
    rows = []
    for customer in customers:
        active_payments = customer.payments.filter(Payment.voided_at.is_(None)).all()
        paid = sum((Decimal(payment.amount) for payment in active_payments), Decimal("0.00"))
        rows.append(
            {
                "customer_name": customer.customer_name,
                "account_number": customer.account_number,
                "phone": customer.phone,
                "monthly_rd_amount": str(customer.monthly_rd_amount),
                "start_date": customer.start_date.isoformat(),
                "maturity_date": customer.maturity_date.isoformat(),
                "status": customer.status,
                "payment_count": len(active_payments),
                "partial_installments": sum(
                    1 for payment in active_payments if Decimal(payment.amount) < Decimal(customer.monthly_rd_amount)
                ),
                "total_collected": str(paid),
            }
        )
    columns = [
        "customer_name",
        "account_number",
        "phone",
        "monthly_rd_amount",
        "start_date",
        "maturity_date",
        "status",
        "payment_count",
        "partial_installments",
        "total_collected",
    ]
    return {"title": "Customer-wise collection report", "columns": columns, "rows": rows, "summary": {"customer_count": len(rows)}}


def pending_report(agent_id, month, year):
    """Include uncollected and partially collected active installments."""
    fully_paid_exists = Payment.query.filter(
        Payment.customer_id == Customer.id,
        Payment.month == month,
        Payment.year == year,
        Payment.voided_at.is_(None),
        Payment.amount >= Customer.monthly_rd_amount,
    ).exists()
    customers = active_collection_customers_query(agent_id, month, year).filter(~fully_paid_exists).order_by(Customer.customer_name.asc()).all()
    customer_ids = [customer.id for customer in customers]
    payments = (
        Payment.query.filter(Payment.customer_id.in_(customer_ids), Payment.month == month, Payment.year == year).all()
        if customer_ids
        else []
    )
    payments_by_customer = {payment.customer_id: payment for payment in payments}
    rows = []
    for customer in customers:
        summary = payment_collection_summary(customer, payments_by_customer.get(customer.id))
        rows.append(
            {
                "customer_name": customer.customer_name,
                "account_number": customer.account_number,
                "phone": customer.phone,
                "monthly_rd_amount": str(customer.monthly_rd_amount),
                "paid_amount": summary["paid_amount"],
                "remaining_amount": summary["remaining_amount"],
                "status": summary["status"],
                "reminder": (
                    f"Dear {customer.customer_name}, your remaining RD installment of "
                    f"Rs. {summary['remaining_amount']} for {month:02d}/{year} is pending. "
                    "Please arrange payment at your convenience."
                ),
            }
        )
    columns = [
        "customer_name",
        "account_number",
        "phone",
        "monthly_rd_amount",
        "paid_amount",
        "remaining_amount",
        "status",
        "reminder",
    ]
    return {
        "title": f"Pending collection - {month:02d}/{year}",
        "columns": columns,
        "rows": rows,
        "summary": {"pending_count": len(rows)},
    }
