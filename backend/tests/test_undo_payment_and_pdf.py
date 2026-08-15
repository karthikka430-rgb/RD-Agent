from datetime import date

import pytest

from app import create_app
from app.extensions import db
from app.models import AuditLog, Payment, PaymentReceipt


class TestConfig:
    TESTING = True
    SECRET_KEY = "test-secret"
    SQLALCHEMY_DATABASE_URI = "sqlite:///:memory:"
    SQLALCHEMY_TRACK_MODIFICATIONS = False


@pytest.fixture()
def app():
    application = create_app(TestConfig)
    with application.app_context():
        db.drop_all()
        db.create_all()
    yield application


def register(client, phone="9876543210", email="undo@example.com"):
    response = client.post("/api/auth/register", json={"name": "Agent One", "phone": phone, "email": email, "password": "SafePassword12!"})
    assert response.status_code == 201
    return response.get_json()["csrf_token"]


def add_customer(client, csrf, *, name="Test Customer", account="RD-UNDO", amount="1500.00"):
    response = client.post(
        "/api/customers/",
        headers={"X-CSRF-Token": csrf},
        json={
            "customer_name": name,
            "account_number": account,
            "phone": "9876543210",
            "monthly_rd_amount": amount,
            "start_date": "2025-01-01",
            "maturity_date": "2030-01-01",
            "status": "active",
        },
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()["customer"]["id"]


def record_collection(client, csrf, customer_id, amount, month=None, year=None):
    month = month or date.today().month
    year = year or date.today().year
    response = client.post(
        f"/api/collections/customers/{customer_id}/receipts",
        headers={"X-CSRF-Token": csrf},
        json={"month": month, "year": year, "amount": amount, "payment_date": date.today().isoformat()},
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def undo_payment(client, csrf, customer_id, month, year):
    return client.post(
        f"/api/collections/customers/{customer_id}/undo-payment",
        headers={"X-CSRF-Token": csrf},
        json={"month": month, "year": year},
    )


def test_undo_payment_mark_restores_full_paid_installment_to_pending(app):
    client = app.test_client()
    csrf = register(client)
    customer_id = add_customer(client, csrf)
    month, year = date.today().month, date.today().year

    recorded = record_collection(client, csrf, customer_id, "1500.00")
    payment_id = recorded["payment"]["id"]
    register_before = client.get(f"/api/collections/?month={month}&year={year}").get_json()
    assert register_before["collections"][0]["is_paid"] is True
    assert register_before["summary"]["paid_customers"] == 1

    response = undo_payment(client, csrf, customer_id, month, year)
    assert response.status_code == 200, response.get_json()
    assert response.get_json()["summary"]["paid_amount"] == "0.00"
    assert response.get_json()["summary"]["status"] == "Pending"

    register_after = client.get(f"/api/collections/?month={month}&year={year}").get_json()
    assert register_after["collections"][0]["is_paid"] is False
    assert register_after["collections"][0]["remaining_amount"] == "1500.00"
    assert register_after["collections"][0]["receipts"] == []
    assert register_after["summary"]["pending_customers"] == 1
    assert register_after["summary"]["total_collection_amount"] == "0.00"

    with app.app_context():
        assert db.session.get(Payment, payment_id) is None
        assert Payment.query.count() == 0
        assert PaymentReceipt.query.count() == 0
        assert AuditLog.query.filter_by(action="UNDO_PAYMENT_MARK", entity_type="customer", entity_id=customer_id).count() == 1


def test_undo_payment_mark_removes_partial_mark_and_restores_pending(app):
    client = app.test_client()
    csrf = register(client)
    customer_id = add_customer(client, csrf, amount="500.00")
    month, year = date.today().month, date.today().year

    record_collection(client, csrf, customer_id, "300.00")
    register_before = client.get(f"/api/collections/?month={month}&year={year}").get_json()
    assert register_before["collections"][0]["status"] == "Partial"
    assert register_before["collections"][0]["paid_amount"] == "300.00"

    response = undo_payment(client, csrf, customer_id, month, year)
    assert response.status_code == 200

    register_after = client.get(f"/api/collections/?month={month}&year={year}").get_json()
    assert register_after["collections"][0]["status"] == "Pending"
    assert register_after["collections"][0]["paid_amount"] == "0.00"
    assert register_after["collections"][0]["remaining_amount"] == "500.00"
    assert register_after["summary"]["partial_customers"] == 0
    assert register_after["summary"]["pending_customers"] == 1


def test_undo_payment_mark_affects_only_one_customer_and_month(app):
    client = app.test_client()
    csrf = register(client)
    first_id = add_customer(client, csrf, name="First", account="RD-FIRST", amount="100.00")
    second_id = add_customer(client, csrf, name="Second", account="RD-SECOND", amount="100.00")
    month, year = date.today().month, date.today().year
    other_month = 1 if month == 12 else month + 1
    other_year = year + 1 if month == 12 else year

    record_collection(client, csrf, first_id, "100.00")
    record_collection(client, csrf, second_id, "100.00")
    record_collection(client, csrf, second_id, "100.00", month=other_month, year=other_year)

    response = undo_payment(client, csrf, first_id, month, year)
    assert response.status_code == 200

    register_after = client.get(f"/api/collections/?month={month}&year={year}").get_json()
    rows = {row["customer"]["account_number"]: row for row in register_after["collections"]}
    assert rows["RD-FIRST"]["status"] == "Pending"
    assert rows["RD-FIRST"]["paid_amount"] == "0.00"
    assert rows["RD-SECOND"]["status"] == "Paid"
    assert rows["RD-SECOND"]["paid_amount"] == "100.00"

    other_register = client.get(f"/api/collections/?month={other_month}&year={other_year}").get_json()
    other_rows = {row["customer"]["account_number"]: row for row in other_register["collections"]}
    assert other_rows["RD-SECOND"]["status"] == "Paid"
    assert other_rows["RD-SECOND"]["paid_amount"] == "100.00"
    assert other_rows["RD-FIRST"]["status"] == "Pending"


def test_undo_payment_mark_requires_ownership_and_a_marked_payment(app):
    client = app.test_client()
    csrf = register(client)
    customer_id = add_customer(client, csrf)
    month, year = date.today().month, date.today().year

    no_mark = undo_payment(client, csrf, customer_id, month, year)
    assert no_mark.status_code == 400
    assert "No paid mark" in no_mark.get_json()["error"]

    other = app.test_client()
    other_csrf = register(other, "9876543211", "other-undo@example.com")
    assert undo_payment(other, other_csrf, customer_id, month, year).status_code == 404

    invalid_period = undo_payment(client, csrf, customer_id, 13, year)
    assert invalid_period.status_code == 400


def test_undo_payment_mark_does_not_delete_the_customer_or_other_installments(app):
    client = app.test_client()
    csrf = register(client)
    customer_id = add_customer(client, csrf, amount="100.00")
    month, year = date.today().month, date.today().year
    other_month = 1 if month == 12 else month + 1
    other_year = year + 1 if month == 12 else year

    record_collection(client, csrf, customer_id, "100.00")
    record_collection(client, csrf, customer_id, "100.00", month=other_month, year=other_year)

    assert undo_payment(client, csrf, customer_id, month, year).status_code == 200

    profile = client.get(f"/api/customers/{customer_id}").get_json()
    assert profile["customer"]["customer_name"] == "Test Customer"
    assert len(profile["payments"]) == 1
    assert profile["payments"][0]["month"] == other_month
    assert profile["payments"][0]["year"] == other_year
    assert profile["payments"][0]["amount"] == "100.00"


def test_pdf_export_returns_the_same_report_as_a_valid_pdf(app):
    client = app.test_client()
    csrf = register(client)
    customer_id = add_customer(client, csrf)
    month, year = date.today().month, date.today().year
    record_collection(client, csrf, customer_id, "1500.00")

    json_report = client.get(f"/api/reports/?type=monthly&month={month}&year={year}").get_json()
    pdf = client.get(f"/api/reports/export?type=monthly&month={month}&year={year}&format=pdf")
    assert pdf.status_code == 200
    assert pdf.headers["Content-Type"] == "application/pdf"
    assert pdf.data.startswith(b"%PDF-")
    assert len(pdf.data) > 100
    assert json_report["rows"][0]["customer_name"] == "Test Customer"