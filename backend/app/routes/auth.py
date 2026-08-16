from sqlalchemy.exc import IntegrityError
from flask import Blueprint, g, jsonify, request, session

from ..extensions import db
from ..models import Agent, AuditLog, Customer, RefreshToken, private_email_placeholder, utcnow
from ..services.audit_service import log_change
from ..utils import (
    ValidationError,
    api_error,
    ensure_csrf_token,
    generate_refresh_token,
    hash_refresh_token,
    require_string,
    validate_optional_email,
    validate_phone,
)
from .common import require_auth, require_csrf

auth_bp = Blueprint("auth", __name__)


def _issue_refresh_token(agent_id):
    token = generate_refresh_token()
    db.session.add(RefreshToken(agent_id=agent_id, token_hash=hash_refresh_token(token)))
    db.session.commit()
    return token


def _delete_agent_records(agent):
    """Permanently remove an agent and every record that belongs to them.

    Deletion order respects the foreign keys between financial tables so no
    orphaned rows can remain. Audit rows are removed too because they reference
    the agent and its deleted customers.
    """
    agent_id = agent.id
    for customer in Customer.query.filter_by(agent_id=agent_id).all():
        for payment in list(customer.payments):
            for receipt in list(payment.receipts):
                db.session.delete(receipt)
            db.session.delete(payment)
        db.session.delete(customer)
    RefreshToken.query.filter_by(agent_id=agent_id).delete(synchronize_session=False)
    AuditLog.query.filter_by(agent_id=agent_id).delete(synchronize_session=False)
    db.session.delete(agent)


@auth_bp.post("/register")
def register():
    """Self-registration is appropriate for an individual-agent deployment."""
    data = request.get_json(silent=True) or {}
    try:
        name = require_string(data, "name", 120)
        phone = validate_phone(data.get("phone"))
        email = validate_optional_email(data.get("email"))
        password = require_string(data, "password", 128)
        if len(password) < 12:
            raise ValidationError("Password must contain at least 12 characters.", "password")
        if Agent.query.filter_by(phone=phone).first():
            raise ValidationError("An account with that phone number already exists.", "phone")
        if email and Agent.query.filter_by(email=email).first():
            raise ValidationError("An account with that email already exists.", "email")
        agent = Agent(name=name, phone=phone, email=email or private_email_placeholder())
        agent.set_password(password)
        db.session.add(agent)
        db.session.commit()
    except ValidationError as exc:
        db.session.rollback()
        return api_error(exc.message, 400, exc.field)
    except IntegrityError:
        db.session.rollback()
        return api_error("An account with that phone number or email already exists.", 409)
    session.clear()
    session["agent_id"] = agent.id
    refresh_token = _issue_refresh_token(agent.id)
    return jsonify({"agent": agent.public_dict(), "csrf_token": ensure_csrf_token(), "refresh_token": refresh_token}), 201


@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    try:
        phone = validate_phone(data.get("phone"))
        password = require_string(data, "password", 128)
    except ValidationError as exc:
        return api_error(exc.message, 400, exc.field)
    agent = Agent.query.filter_by(phone=phone).first()
    if not agent or not agent.check_password(password):
        return api_error("Invalid phone number or password.", 401)
    session.clear()  # prevents session fixation on login
    session["agent_id"] = agent.id
    refresh_token = _issue_refresh_token(agent.id)
    return jsonify({"agent": agent.public_dict(), "csrf_token": ensure_csrf_token(), "refresh_token": refresh_token})


@auth_bp.post("/refresh")
def refresh():
    """Restore a session from a device-persisted refresh token.

    The token is rotated on every use: the presented token is revoked and a
    fresh one is issued, so a lost or replayed token cannot be reused.
    """
    data = request.get_json(silent=True) or {}
    raw_token = data.get("refresh_token")
    if not isinstance(raw_token, str) or not raw_token:
        return api_error("Refresh token is required.", 400, "refresh_token")
    stored = RefreshToken.query.filter_by(token_hash=hash_refresh_token(raw_token)).first()
    if not stored or stored.revoked_at:
        return api_error("Session expired. Please sign in again.", 401)
    agent = db.session.get(Agent, stored.agent_id)
    if not agent:
        return api_error("Session expired. Please sign in again.", 401)
    stored.revoked_at = utcnow()
    stored.last_used_at = utcnow()
    new_token = _issue_refresh_token(agent.id)
    session.clear()
    session["agent_id"] = agent.id
    return jsonify({"agent": agent.public_dict(), "csrf_token": ensure_csrf_token(), "refresh_token": new_token})


@auth_bp.post("/token")
@require_auth
@require_csrf
def mint_token():
    """Issue a refresh token to the currently authenticated agent (CSRF protected).

    Used so an already signed-in agent who has no stored device token can obtain
    one without entering credentials again.
    """
    refresh_token = _issue_refresh_token(g.agent.id)
    return jsonify({"refresh_token": refresh_token})


@auth_bp.post("/logout")
@require_auth
@require_csrf
def logout():
    data = request.get_json(silent=True) or {}
    raw_token = data.get("refresh_token")
    if isinstance(raw_token, str) and raw_token:
        stored = RefreshToken.query.filter_by(token_hash=hash_refresh_token(raw_token)).first()
        if stored and stored.agent_id == g.agent.id and not stored.revoked_at:
            stored.revoked_at = utcnow()
            db.session.commit()
    session.clear()
    return "", 204


@auth_bp.get("/me")
@require_auth
def me():
    return jsonify({"agent": g.agent.public_dict(), "csrf_token": ensure_csrf_token()})


@auth_bp.put("/profile")
@require_auth
@require_csrf
def update_profile():
    """Update contact information without affecting customer or financial records."""
    data = request.get_json(silent=True) or {}
    try:
        name = require_string(data, "name", 120)
        phone = validate_phone(data.get("phone"))
        email = validate_optional_email(data.get("email"))
        if Agent.query.filter(Agent.phone == phone, Agent.id != g.agent.id).first():
            raise ValidationError("An account with that phone number already exists.", "phone")
        if email and Agent.query.filter(Agent.email == email, Agent.id != g.agent.id).first():
            raise ValidationError("An account with that email already exists.", "email")
        old = g.agent.public_dict()
        g.agent.name = name
        g.agent.phone = phone
        g.agent.email = email or private_email_placeholder()
        db.session.flush()
        log_change(g.agent.id, "UPDATE", "agent", g.agent.id, old, g.agent.public_dict())
        db.session.commit()
    except ValidationError as exc:
        db.session.rollback()
        return api_error(exc.message, 400, exc.field)
    except IntegrityError:
        db.session.rollback()
        return api_error("An account with that phone number or email already exists.", 409)
    return jsonify({"agent": g.agent.public_dict(), "csrf_token": ensure_csrf_token()})


@auth_bp.post("/account/verify")
@require_auth
@require_csrf
def verify_delete_account():
    """Step 1 of account deletion: prove ownership with the existing password.

    The verified flag is stored server-side in the session, so account deletion
    can never happen from a single request or accidental tap.
    """
    data = request.get_json(silent=True) or {}
    try:
        password = require_string(data, "password", 128)
    except ValidationError as exc:
        return api_error(exc.message, 400, exc.field)
    if not g.agent.check_password(password):
        return api_error("Incorrect password. Verify and try again.", 401, "password")
    session["account_delete_verified"] = True
    return jsonify({"verified": True})


@auth_bp.post("/account/delete")
@require_auth
@require_csrf
def delete_account():
    """Step 2 of account deletion: irreversible removal after both verifications.

    Requires the password verification flag set by /account/verify plus an
    explicit typed confirmation, so no single accidental action can wipe the
    account, its customers, collections, receipts, or audit records.
    """
    if not session.get("account_delete_verified"):
        return api_error("Verify your password before deleting the account.", 403)
    data = request.get_json(silent=True) or {}
    if data.get("confirmation") != "DELETE":
        return api_error("Type DELETE to confirm account deletion.", 400, "confirmation")
    agent = g.agent
    _delete_agent_records(agent)
    db.session.commit()
    session.clear()
    return jsonify({"deleted": True})
