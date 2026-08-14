from datetime import date

from flask import Blueprint, g, jsonify, request
from sqlalchemy import func

from ..models import Customer, Payment
from ..services.customer_service import active_collection_customers_query, collection_period_bounds
from ..services.payment_service import payment_collection_summary, payment_receipt_history
from ..utils import ValidationError, api_error, parse_int_in_range
from .common import require_auth

dashboard_bp = Blueprint("dashboard", __name__)


def requested_period():
    today = date.today()
    try:
        month = parse_int_in_range(request.args.get("month", today.month), "month", 1, 12)
        year = parse_int_in_range(request.args.get("year", today.year), "year", 2000, 2200)
    except ValidationError as exc:
        raise exc
    return month, year


def pending_customers(agent_id, month, year, search=None):
    fully_paid_exists = Payment.query.filter(
        Payment.customer_id == Customer.id,
        Payment.month == month,
        Payment.year == year,
        Payment.voided_at.is_(None),
        Payment.amount >= Customer.monthly_rd_amount,
    ).exists()
    query = active_collection_customers_query(agent_id, month, year).filter(~fully_paid_exists)
    if search:
        term = f"%{search.strip()}%"
        query = query.filter((Customer.customer_name.ilike(term)) | (Customer.account_number.ilike(term)) | (Customer.phone.ilike(term)))
    return query.order_by(Customer.customer_name.asc())


@dashboard_bp.get("/")
@require_auth
def dashboard():
    try:
        month, year = requested_period()
    except ValidationError as exc:
        return api_error(exc.message, 400, exc.field)
    # Dashboard collection metrics use the same monthly sheet as the register.
    total_customers = active_collection_customers_query(g.agent.id, month, year).count()
    first_day, last_day = collection_period_bounds(month, year)
    current_payments = (
        Payment.query.join(Customer)
        .filter(
            Customer.agent_id == g.agent.id,
            Customer.status == "active",
            Customer.start_date <= last_day,
            Customer.maturity_date >= first_day,
            Payment.month == month,
            Payment.year == year,
            Payment.voided_at.is_(None),
        )
    )
    collected = current_payments.with_entities(func.coalesce(func.sum(Payment.amount), 0)).scalar()
    pending = pending_customers(g.agent.id, month, year)
    paid_customers = current_payments.filter(Payment.amount >= Customer.monthly_rd_amount).count()
    partial_customers = current_payments.filter(Payment.amount < Customer.monthly_rd_amount).count()
    recent_payments = (
        Payment.query.join(Customer)
        .filter(Customer.agent_id == g.agent.id)
        .order_by(Payment.created_at.desc())
        .limit(100)
        .all()
    )
    recent_items = []
    for payment in recent_payments:
        for receipt in payment_receipt_history(payment):
            recent_items.append(
                {
                    "customer_name": payment.customer.customer_name,
                    "account_number": payment.customer.account_number,
                    "month": payment.month,
                    "year": payment.year,
                    "amount": receipt["amount"],
                    "payment_date": receipt["payment_date"],
                    "receipt_number": receipt["receipt_number"],
                    "is_void": payment.is_void,
                    "status": "Voided" if payment.is_void else payment_collection_summary(payment.customer, payment)["status"],
                    "recorded_at": receipt.get("created_at") or payment.created_at.isoformat(),
                }
            )
    recent_items.sort(key=lambda item: item["recorded_at"], reverse=True)
    return jsonify(
        {
            "period": {"month": month, "year": year},
            "metrics": {
                "total_customers": total_customers,
                "paid_customers": paid_customers,
                "partial_customers": partial_customers,
                "collection": str(collected),
                "pending_count": pending.count(),
            },
            "recent_transactions": recent_items[:8],
        }
    )


@dashboard_bp.get("/pending")
@require_auth
def pending():
    try:
        month, year = requested_period()
    except ValidationError as exc:
        return api_error(exc.message, 400, exc.field)
    search = request.args.get("search", "")
    if len(search) > 160:
        return api_error("Search text is too long.", 400, "search")
    results = pending_customers(g.agent.id, month, year, search).all()
    customer_ids = [customer.id for customer in results]
    payments = []
    if customer_ids:
        payments = Payment.query.filter(Payment.customer_id.in_(customer_ids), Payment.month == month, Payment.year == year).all()
    payments_by_customer = {payment.customer_id: payment for payment in payments}
    return jsonify(
        {
            "period": {"month": month, "year": year},
            "customers": [{"customer": customer.public_dict(), **payment_collection_summary(customer, payments_by_customer.get(customer.id))} for customer in results],
        }
    )
