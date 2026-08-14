from flask import Blueprint, g, jsonify, request

from ..models import Customer, Payment
from ..services.payment_service import create_payments, update_payment
from ..utils import ValidationError, api_error
from .common import require_auth, require_csrf

payments_bp = Blueprint("payments", __name__)


def owned_customer(customer_id):
    return Customer.query.filter_by(id=customer_id, agent_id=g.agent.id).first()


def owned_payment(payment_id):
    return Payment.query.join(Customer).filter(Payment.id == payment_id, Customer.agent_id == g.agent.id).first()


@payments_bp.get("/customers/<int:customer_id>")
@require_auth
def list_payments(customer_id):
    customer = owned_customer(customer_id)
    if not customer:
        return api_error("Customer not found.", 404)
    payments = customer.payments.order_by(Payment.year.desc(), Payment.month.desc()).all()
    return jsonify({"payments": [payment.public_dict() for payment in payments]})


@payments_bp.post("/customers/<int:customer_id>")
@require_auth
@require_csrf
def record_payments(customer_id):
    customer = owned_customer(customer_id)
    if not customer:
        return api_error("Customer not found.", 404)
    data = request.get_json(silent=True) or {}
    try:
        payments = create_payments(g.agent, customer, data.get("payments"))
    except ValidationError as exc:
        return api_error(exc.message, 400, exc.field)
    return jsonify({"payments": [payment.public_dict() for payment in payments]}), 201


@payments_bp.put("/<int:payment_id>")
@require_auth
@require_csrf
def edit_payment(payment_id):
    payment = owned_payment(payment_id)
    if not payment:
        return api_error("Payment not found.", 404)
    try:
        payment = update_payment(g.agent, payment, request.get_json(silent=True) or {})
    except ValidationError as exc:
        return api_error(exc.message, 400, exc.field)
    return jsonify({"payment": payment.public_dict()})


@payments_bp.post("/<int:payment_id>/void")
@require_auth
@require_csrf
def void(payment_id):
    payment = owned_payment(payment_id)
    if not payment:
        return api_error("Payment not found.", 404)
    return api_error("Paid payment records are final and cannot be voided.", 409)
