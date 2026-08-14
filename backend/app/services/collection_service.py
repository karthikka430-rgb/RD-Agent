from ..utils import ValidationError
from .customer_service import should_be_due
from .payment_service import record_payment_receipt


def set_collection_status(agent, customer, month, year, paid, confirmed=False):
    """Legacy full-payment handler retained for compatibility with existing API clients."""
    if not should_be_due(customer, month, year):
        raise ValidationError("This customer does not have an active RD term for the selected collection month.")
    if not paid:
        raise ValidationError("Paid collection records are final and cannot be reverted.", "paid")
    from datetime import date
    payment, _receipt, action = record_payment_receipt(
        agent, customer, month, year, customer.monthly_rd_amount, date.today()
    )
    return payment, action
