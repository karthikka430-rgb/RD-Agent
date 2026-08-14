from calendar import monthrange
from datetime import date

from sqlalchemy import or_

from ..models import Customer
from ..utils import ValidationError, parse_date, parse_positive_money, require_string, validate_phone


VALID_STATUSES = {"active", "matured", "closed", "archived"}


def customer_from_payload(payload, existing=None):
    if not isinstance(payload, dict):
        raise ValidationError("Request body must be a JSON object.")
    name = require_string(payload, "customer_name", 160)
    account = require_string(payload, "account_number", 64).upper()
    phone = validate_phone(payload.get("phone"))
    amount = parse_positive_money(payload.get("monthly_rd_amount"), "monthly_rd_amount")
    start = parse_date(payload.get("start_date"), "start_date")
    maturity = parse_date(payload.get("maturity_date"), "maturity_date")
    status = payload.get("status", existing.status if existing else "active")
    if status not in VALID_STATUSES - {"archived"}:
        raise ValidationError("Status must be active, matured, or closed.", "status")
    if maturity <= start:
        raise ValidationError("Maturity date must be after start date.", "maturity_date")
    return {
        "customer_name": name,
        "account_number": account,
        "phone": phone,
        "monthly_rd_amount": amount,
        "start_date": start,
        "maturity_date": maturity,
        "status": status,
    }


def customer_query(agent_id, search=None, status=None):
    query = Customer.query.filter_by(agent_id=agent_id)
    if status:
        if status not in VALID_STATUSES:
            raise ValidationError("Invalid customer status.", "status")
        query = query.filter(Customer.status == status)
    else:
        query = query.filter(Customer.status != "archived")
    if search:
        term = f"%{search.strip()}%"
        query = query.filter(or_(Customer.customer_name.ilike(term), Customer.account_number.ilike(term), Customer.phone.ilike(term)))
    return query.order_by(Customer.customer_name.asc())


def should_be_due(customer, month, year):
    """Return whether a selected calendar month overlaps an active RD term.

    This deliberately works at a month level. For example, an account that
    starts on 12 Aug may collect its August installment, and an agent may
    record a valid future/pre-paid installment before maturity. A month after
    maturity (or before start) is never eligible.
    """
    first_day, last_day = collection_period_bounds(month, year)
    return customer.status == "active" and customer.start_date <= last_day and customer.maturity_date >= first_day


def collection_period_bounds(month, year):
    return date(year, month, 1), date(year, month, monthrange(year, month)[1])


def active_collection_customers_query(agent_id, month, year):
    """Query each active customer that belongs on the selected monthly sheet."""
    first_day, last_day = collection_period_bounds(month, year)
    return Customer.query.filter(
        Customer.agent_id == agent_id,
        Customer.status == "active",
        Customer.start_date <= last_day,
        Customer.maturity_date >= first_day,
    )
