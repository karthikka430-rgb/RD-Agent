import hashlib
import json
import re
import secrets
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from flask import jsonify, session


class ValidationError(Exception):
    def __init__(self, message, field=None):
        super().__init__(message)
        self.message = message
        self.field = field


def api_error(message, status=400, field=None):
    body = {"error": message}
    if field:
        body["field"] = field
    return jsonify(body), status


def require_string(data, key, max_length=255):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{key.replace('_', ' ').title()} is required.", key)
    value = value.strip()
    if len(value) > max_length:
        raise ValidationError(f"{key.replace('_', ' ').title()} is too long.", key)
    return value


def parse_date(value, field):
    if not isinstance(value, str):
        raise ValidationError(f"{field.replace('_', ' ').title()} must be a valid date.", field)
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValidationError(f"{field.replace('_', ' ').title()} must use YYYY-MM-DD.", field) from exc


def parse_positive_money(value, field):
    try:
        amount = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError) as exc:
        raise ValidationError(f"{field.replace('_', ' ').title()} must be a valid amount.", field) from exc
    if amount <= 0 or amount > Decimal("9999999999.99"):
        raise ValidationError(f"{field.replace('_', ' ').title()} must be greater than zero.", field)
    return amount


def parse_int_in_range(value, field, low, high):
    if isinstance(value, bool):
        raise ValidationError(f"{field.replace('_', ' ').title()} must be a number.", field)
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"{field.replace('_', ' ').title()} must be a number.", field) from exc
    if parsed < low or parsed > high:
        raise ValidationError(f"{field.replace('_', ' ').title()} must be between {low} and {high}.", field)
    return parsed


def validate_phone(value):
    value = require_string({"phone": value}, "phone", 30)
    if not re.fullmatch(r"[0-9+() .-]{6,30}", value):
        raise ValidationError("Phone contains invalid characters.", "phone")
    return value


def validate_email(value):
    value = require_string({"email": value}, "email", 255).lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
        raise ValidationError("Enter a valid email address.", "email")
    return value


def validate_optional_email(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValidationError("Enter a valid email address.", "email")
    return validate_email(value) if value.strip() else None


def serialize_for_audit(value):
    if value is None:
        return None
    return json.dumps(value, default=lambda item: item.isoformat() if isinstance(item, (date, datetime)) else str(item), sort_keys=True)


def ensure_csrf_token():
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def generate_refresh_token():
    return secrets.token_urlsafe(48)


def hash_refresh_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
