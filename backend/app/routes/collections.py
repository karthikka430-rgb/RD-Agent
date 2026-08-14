from datetime import date
from decimal import Decimal

from flask import Blueprint, g, jsonify, request

from ..models import Customer, Payment
from ..services.customer_service import active_collection_customers_query
from ..services.payment_service import payment_collection_summary, record_payment_receipt
from ..utils import ValidationError, api_error, parse_date, parse_int_in_range, parse_positive_money
from .common import require_auth, require_csrf

collections_bp = Blueprint("collections", __name__)


def requested_period():
    today = date.today()
    month = parse_int_in_range(request.args.get("month", today.month), "month", 1, 12)
    year = parse_int_in_range(request.args.get("year", today.year), "year", 2000, 2200)
    return month, year


@collections_bp.get("/")
@require_auth
def collection_register():
    """One monthly sheet containing each eligible active customer exactly once.

    A cycle is derived from the selected calendar month and the unique
    (customer_id, month, year) payment constraint. The sheet includes every
    active RD account whose term overlaps the selected month. Consequently, it
    needs no reset job: a newly selected eligible month has no payment rows yet,
    so every listed customer is Pending until their checkbox creates one.
    """
    try:
        month, year = requested_period()
    except ValidationError as exc:
        return api_error(exc.message, 400, exc.field)
    customers = active_collection_customers_query(g.agent.id, month, year).order_by(Customer.customer_name.asc()).all()
    customer_ids = [customer.id for customer in customers]
    payments = []
    if customer_ids:
        payments = Payment.query.filter(Payment.customer_id.in_(customer_ids), Payment.month == month, Payment.year == year).all()
    payments_by_customer = {payment.customer_id: payment for payment in payments}
    rows = []
    total_collected = Decimal("0.00")
    paid_count = 0
    partial_count = 0
    for customer in customers:
        payment = payments_by_customer.get(customer.id)
        summary = payment_collection_summary(customer, payment)
        if summary["is_paid"]:
            paid_count += 1
        if summary["is_partial"]:
            partial_count += 1
        total_collected += payment.amount if payment and not payment.is_void else 0
        rows.append(
            {
                "customer": customer.public_dict(),
                **summary,
            }
        )
    return jsonify(
        {
            "period": {"month": month, "year": year},
            "collections": rows,
            "summary": {
                "total_customers": len(rows),
                "paid_customers": paid_count,
                "partial_customers": partial_count,
                "pending_customers": len(rows) - paid_count - partial_count,
                "total_collection_amount": str(total_collected),
            },
        }
    )


@collections_bp.post("/customers/<int:customer_id>/receipts")
@require_auth
@require_csrf
def record_collection_receipt(customer_id):
    customer = Customer.query.filter_by(id=customer_id, agent_id=g.agent.id).first()
    if not customer:
        return api_error("Customer not found.", 404)
    data = request.get_json(silent=True) or {}
    try:
        month = parse_int_in_range(data.get("month"), "month", 1, 12)
        year = parse_int_in_range(data.get("year"), "year", 2000, 2200)
        amount = parse_positive_money(data.get("amount"), "amount")
        payment_date = parse_date(data.get("payment_date"), "payment_date")
        payment, receipt, action = record_payment_receipt(g.agent, customer, month, year, amount, payment_date)
    except ValidationError as exc:
        return api_error(exc.message, 400, exc.field)
    return jsonify({"payment": payment.public_dict(), "receipt": receipt.public_dict(), "summary": payment_collection_summary(customer, payment), "action": action}), 201


@collections_bp.post("/customers/<int:customer_id>/status")
@require_auth
@require_csrf
def update_collection_status(customer_id):
    """Compatibility endpoint for older checkbox clients.

    New clients should use the receipt endpoint and provide an amount. A legacy
    checked box records exactly the remaining installment balance; it can never
    unset or reverse an already recorded collection.
    """
    customer = Customer.query.filter_by(id=customer_id, agent_id=g.agent.id).first()
    if not customer:
        return api_error("Customer not found.", 404)
    data = request.get_json(silent=True) or {}
    if data.get("paid") is not True:
        return api_error("Paid collection records are final and cannot be reverted.", 400, "paid")
    try:
        month = parse_int_in_range(data.get("month"), "month", 1, 12)
        year = parse_int_in_range(data.get("year"), "year", 2000, 2200)
        existing = Payment.query.filter_by(customer_id=customer.id, month=month, year=year).first()
        remaining = Decimal(customer.monthly_rd_amount) - (Decimal(existing.amount) if existing and not existing.is_void else Decimal("0.00"))
        if remaining <= 0:
            return api_error("This monthly RD installment is already fully paid.", 400, "paid")
        payment, receipt, action = record_payment_receipt(g.agent, customer, month, year, remaining, date.today())
    except ValidationError as exc:
        return api_error(exc.message, 400, exc.field)
    return jsonify({"payment": payment.public_dict(), "receipt": receipt.public_dict(), "summary": payment_collection_summary(customer, payment), "action": action}), 201
