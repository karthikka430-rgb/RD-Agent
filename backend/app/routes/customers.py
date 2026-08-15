from datetime import datetime, timezone

from flask import Blueprint, g, jsonify, request
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import AuditLog, Customer, Payment, PaymentReceipt
from ..services.audit_service import log_change
from ..services.customer_service import customer_from_payload, customer_query
from ..services.payment_service import payment_collection_summary
from ..utils import ValidationError, api_error, parse_int_in_range
from .common import require_auth, require_csrf

customers_bp = Blueprint("customers", __name__)


def owned_customer(customer_id):
    return Customer.query.filter_by(id=customer_id, agent_id=g.agent.id).first()


def pagination_args():
    try:
        page = parse_int_in_range(request.args.get("page", 1), "page", 1, 100000)
        per_page = parse_int_in_range(request.args.get("per_page", 10), "per_page", 1, 100)
        return page, per_page
    except ValidationError as exc:
        raise exc


@customers_bp.get("/")
@require_auth
def list_customers():
    try:
        page, per_page = pagination_args()
        query = customer_query(g.agent.id, request.args.get("search", ""), request.args.get("status"))
    except ValidationError as exc:
        return api_error(exc.message, 400, exc.field)
    result = query.paginate(page=page, per_page=per_page, error_out=False)
    return jsonify(
        {
            "customers": [customer.public_dict() for customer in result.items],
            "pagination": {"page": result.page, "per_page": result.per_page, "pages": result.pages, "total": result.total},
        }
    )


@customers_bp.post("/")
@require_auth
@require_csrf
def create_customer():
    try:
        values = customer_from_payload(request.get_json(silent=True) or {})
        customer = Customer(agent_id=g.agent.id, **values)
        db.session.add(customer)
        db.session.flush()
        log_change(g.agent.id, "CREATE", "customer", customer.id, new_value=customer.public_dict())
        db.session.commit()
        return jsonify({"customer": customer.public_dict()}), 201
    except ValidationError as exc:
        db.session.rollback()
        return api_error(exc.message, 400, exc.field)
    except IntegrityError:
        db.session.rollback()
        return api_error("This account number already exists for your account.", 409, "account_number")


@customers_bp.get("/<int:customer_id>")
@require_auth
def get_customer(customer_id):
    customer = owned_customer(customer_id)
    if not customer:
        return api_error("Customer not found.", 404)
    payments = customer.payments.order_by(Payment.year.desc(), Payment.month.desc()).all()
    payment_rows = []
    for payment in payments:
        payment_row = payment.public_dict()
        summary = payment_collection_summary(customer, payment)
        payment_row.update({key: value for key, value in summary.items() if key != "payment"})
        payment_rows.append(payment_row)
    return jsonify({"customer": customer.public_dict(), "payments": payment_rows})


@customers_bp.put("/<int:customer_id>")
@require_auth
@require_csrf
def update_customer(customer_id):
    customer = owned_customer(customer_id)
    if not customer or customer.status == "archived":
        return api_error("Customer not found.", 404)
    try:
        old = customer.public_dict()
        values = customer_from_payload(request.get_json(silent=True) or {}, customer)
        for key, value in values.items():
            setattr(customer, key, value)
        db.session.flush()
        log_change(g.agent.id, "UPDATE", "customer", customer.id, old, customer.public_dict())
        db.session.commit()
        return jsonify({"customer": customer.public_dict()})
    except ValidationError as exc:
        db.session.rollback()
        return api_error(exc.message, 400, exc.field)
    except IntegrityError:
        db.session.rollback()
        return api_error("This account number already exists for your account.", 409, "account_number")


@customers_bp.delete("/<int:customer_id>")
@require_auth
@require_csrf
def archive_customer(customer_id):
    customer = owned_customer(customer_id)
    data = request.get_json(silent=True) or {}
    if not customer or customer.status == "archived":
        return api_error("Customer not found.", 404)
    if data.get("confirmation") != "ARCHIVE":
        return api_error("Type ARCHIVE to archive this customer.", 400, "confirmation")
    old = customer.public_dict()
    customer.status = "archived"
    customer.archived_at = datetime.now(timezone.utc)
    db.session.flush()
    log_change(g.agent.id, "ARCHIVE", "customer", customer.id, old, customer.public_dict())
    db.session.commit()
    return "", 204


@customers_bp.post("/<int:customer_id>/delete")
@require_auth
@require_csrf
def delete_customer(customer_id):
    """Permanently delete a CLOSED customer and every record that belongs to it.

    This is the only path that removes financial records. It is deliberately
    restricted to customers already marked CLOSED so an active or matured
    account can never be removed by accident. Changing a status to CLOSED never
    deletes anything; deletion happens only here, after an explicit confirmation.
    """
    customer = owned_customer(customer_id)
    if not customer:
        return api_error("Customer not found.", 404)
    if customer.status != "closed":
        return api_error("Only CLOSED customers can be deleted.", 400, "status")
    data = request.get_json(silent=True) or {}
    if data.get("confirmation") != "DELETE":
        return api_error("Type DELETE to confirm the deletion.", 400, "confirmation")
    payment_ids = []
    receipt_ids = []
    for payment in list(customer.payments):
        payment_ids.append(payment.id)
        for receipt in list(payment.receipts):
            receipt_ids.append(receipt.id)
            db.session.delete(receipt)
        db.session.delete(payment)
    if payment_ids:
        AuditLog.query.filter(AuditLog.agent_id == g.agent.id, AuditLog.entity_type == "payment", AuditLog.entity_id.in_(payment_ids)).delete(synchronize_session=False)
    if receipt_ids:
        AuditLog.query.filter(AuditLog.agent_id == g.agent.id, AuditLog.entity_type == "payment_receipt", AuditLog.entity_id.in_(receipt_ids)).delete(synchronize_session=False)
    AuditLog.query.filter(AuditLog.agent_id == g.agent.id, AuditLog.entity_type == "customer", AuditLog.entity_id == customer.id).delete(synchronize_session=False)
    old = customer.public_dict()
    db.session.delete(customer)
    log_change(g.agent.id, "DELETE", "customer", customer.id, old_value=old)
    db.session.commit()
    return "", 204


@customers_bp.get("/<int:customer_id>/audit")
@require_auth
def customer_audit(customer_id):
    customer = owned_customer(customer_id)
    if not customer:
        return api_error("Customer not found.", 404)
    logs = (
        AuditLog.query.filter_by(agent_id=g.agent.id)
        .filter((AuditLog.entity_type == "customer") & (AuditLog.entity_id == customer.id))
        .order_by(AuditLog.timestamp.desc())
        .all()
    )
    payment_ids = [payment.id for payment in customer.payments]
    if payment_ids:
        logs += AuditLog.query.filter(AuditLog.agent_id == g.agent.id, AuditLog.entity_type == "payment", AuditLog.entity_id.in_(payment_ids)).all()
        receipt_ids = [receipt.id for receipt in PaymentReceipt.query.filter(PaymentReceipt.payment_id.in_(payment_ids)).all()]
        if receipt_ids:
            logs += AuditLog.query.filter(AuditLog.agent_id == g.agent.id, AuditLog.entity_type == "payment_receipt", AuditLog.entity_id.in_(receipt_ids)).all()
    logs.sort(key=lambda log: log.timestamp, reverse=True)
    return jsonify({"audit_logs": [log.as_dict() for log in logs]})
