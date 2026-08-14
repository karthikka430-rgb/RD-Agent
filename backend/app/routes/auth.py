from sqlalchemy.exc import IntegrityError
from flask import Blueprint, g, jsonify, request, session

from ..extensions import db
from ..models import Agent, private_email_placeholder
from ..services.audit_service import log_change
from ..utils import ValidationError, api_error, ensure_csrf_token, require_string, validate_optional_email, validate_phone
from .common import require_auth, require_csrf

auth_bp = Blueprint("auth", __name__)


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
    return jsonify({"agent": agent.public_dict(), "csrf_token": ensure_csrf_token()}), 201


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
    return jsonify({"agent": agent.public_dict(), "csrf_token": ensure_csrf_token()})


@auth_bp.post("/logout")
@require_auth
@require_csrf
def logout():
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
