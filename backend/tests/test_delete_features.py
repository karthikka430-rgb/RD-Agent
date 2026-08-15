from datetime import date

import pytest

from app import create_app
from app.extensions import db
from app.models import Agent, AuditLog, BackupSnapshot, Customer, Payment, PaymentReceipt, RefreshToken


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


def register(client, phone="9876543210", email="agent@example.com"):
    response = client.post(
        "/api/auth/register",
        json={"name": "Agent One", "phone": phone, "email": email, "password": "SafePassword12!"},
    )
    assert response.status_code == 201
    return response.get_json()["csrf_token"]


def add_customer(client, csrf, *, account="RD-TEST-1", status="active", name="Test Customer", amount="1500.00"):
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
            "status": status,
        },
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()["customer"]["id"]


def record_collection(client, csrf, customer_id, amount="1500.00", month=None, year=None):
    month = month or date.today().month
    year = year or date.today().year
    response = client.post(
        f"/api/collections/customers/{customer_id}/receipts",
        headers={"X-CSRF-Token": csrf},
        json={"month": month, "year": year, "amount": amount, "payment_date": date.today().isoformat()},
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def test_closed_customer_can_be_deleted_with_related_records(app):
    client = app.test_client()
    csrf = register(client)
    closed_id = add_customer(client, csrf, account="RD-CLOSED-DEL", status="active")
    add_customer(client, csrf, account="RD-KEEP-ME", status="closed")
    record_collection(client, csrf, closed_id)
    closed = client.put(
        f"/api/customers/{closed_id}",
        headers={"X-CSRF-Token": csrf},
        json={
            "customer_name": "Test Customer",
            "account_number": "RD-CLOSED-DEL",
            "phone": "9876543210",
            "monthly_rd_amount": "1500.00",
            "start_date": "2025-01-01",
            "maturity_date": "2030-01-01",
            "status": "closed",
        },
    )
    assert closed.status_code == 200

    assert client.post(f"/api/customers/{closed_id}/delete", headers={"X-CSRF-Token": csrf}, json={"confirmation": "WRONG"}).status_code == 400
    response = client.post(f"/api/customers/{closed_id}/delete", headers={"X-CSRF-Token": csrf}, json={"confirmation": "DELETE"})
    assert response.status_code == 204

    with app.app_context():
        assert Customer.query.filter_by(account_number="RD-CLOSED-DEL").first() is None
        assert Customer.query.filter_by(account_number="RD-KEEP-ME").first() is not None
        assert Payment.query.count() == 0
        assert PaymentReceipt.query.count() == 0
        remaining_ids = [customer.id for customer in Customer.query.all()]
        assert AuditLog.query.filter(AuditLog.entity_type == "customer", AuditLog.entity_id.in_(remaining_ids)).count() >= 1


def test_active_and_matured_customers_cannot_be_deleted(app):
    client = app.test_client()
    csrf = register(client)
    active_id = add_customer(client, csrf, account="RD-ACTIVE", status="active")
    matured_id = add_customer(client, csrf, account="RD-MATURED", status="matured")

    active_delete = client.post(f"/api/customers/{active_id}/delete", headers={"X-CSRF-Token": csrf}, json={"confirmation": "DELETE"})
    assert active_delete.status_code == 400
    assert "CLOSED" in active_delete.get_json()["error"]

    matured_delete = client.post(f"/api/customers/{matured_id}/delete", headers={"X-CSRF-Token": csrf}, json={"confirmation": "DELETE"})
    assert matured_delete.status_code == 400

    with app.app_context():
        assert Customer.query.filter_by(account_number="RD-ACTIVE").first() is not None
        assert Customer.query.filter_by(account_number="RD-MATURED").first() is not None


def test_changing_status_to_closed_never_deletes_the_customer_or_its_data(app):
    client = app.test_client()
    csrf = register(client)
    customer_id = add_customer(client, csrf, account="RD-CLOSE-STAYS", status="active")
    record_collection(client, csrf, customer_id)

    updated = client.put(
        f"/api/customers/{customer_id}",
        headers={"X-CSRF-Token": csrf},
        json={
            "customer_name": "Test Customer",
            "account_number": "RD-CLOSE-STAYS",
            "phone": "9876543210",
            "monthly_rd_amount": "1500.00",
            "start_date": "2025-01-01",
            "maturity_date": "2030-01-01",
            "status": "closed",
        },
    )
    assert updated.status_code == 200

    with app.app_context():
        customer = db.session.get(Customer, customer_id)
        assert customer.status == "closed"
        assert Payment.query.filter_by(customer_id=customer_id).count() == 1
        assert PaymentReceipt.query.count() == 1

    profile = client.get(f"/api/customers/{customer_id}").get_json()
    assert profile["customer"]["status"] == "closed"
    assert len(profile["payments"]) == 1


def test_other_agent_cannot_delete_another_agents_customer(app):
    first = app.test_client()
    first_csrf = register(first, "9876543210", "first@example.com")
    customer_id = add_customer(first, first_csrf, account="RD-OWNED", status="closed")
    second = app.test_client()
    second_csrf = register(second, "9876543211", "second@example.com")
    assert second.post(f"/api/customers/{customer_id}/delete", headers={"X-CSRF-Token": second_csrf}, json={"confirmation": "DELETE"}).status_code == 404


def test_agent_account_deletion_requires_password_and_typed_confirmation(app):
    client = app.test_client()
    csrf = register(client)
    customer_id = add_customer(client, csrf, account="RD-AGENT-DEL")
    record_collection(client, csrf, customer_id)

    wrong_password = client.post("/api/auth/account/verify", headers={"X-CSRF-Token": csrf}, json={"password": "WrongPassword!"})
    assert wrong_password.status_code == 401

    no_verify = client.post("/api/auth/account/delete", headers={"X-CSRF-Token": csrf}, json={"confirmation": "DELETE"})
    assert no_verify.status_code == 403

    verify = client.post("/api/auth/account/verify", headers={"X-CSRF-Token": csrf}, json={"password": "SafePassword12!"})
    assert verify.status_code == 200
    assert verify.get_json()["verified"] is True

    wrong_confirmation = client.post("/api/auth/account/delete", headers={"X-CSRF-Token": csrf}, json={"confirmation": "nope"})
    assert wrong_confirmation.status_code == 400

    deleted = client.post("/api/auth/account/delete", headers={"X-CSRF-Token": csrf}, json={"confirmation": "DELETE"})
    assert deleted.status_code == 200
    assert deleted.get_json()["deleted"] is True

    with app.app_context():
        assert Agent.query.count() == 0
        assert Customer.query.count() == 0
        assert Payment.query.count() == 0
        assert PaymentReceipt.query.count() == 0
        assert AuditLog.query.count() == 0
        assert BackupSnapshot.query.count() == 0
        assert RefreshToken.query.count() == 0


def test_agent_deletion_only_removes_that_agents_records(app):
    doomed = app.test_client()
    doomed_csrf = register(doomed, "9876543210", "doomed@example.com")
    doomed_customer = add_customer(doomed, doomed_csrf, account="RD-DOOMED")
    record_collection(doomed, doomed_csrf, doomed_customer)

    survivor = app.test_client()
    survivor_csrf = register(survivor, "9876543211", "survivor@example.com")
    survivor_customer = add_customer(survivor, survivor_csrf, account="RD-SURVIVOR")
    record_collection(survivor, survivor_csrf, survivor_customer)

    doomed.post("/api/auth/account/verify", headers={"X-CSRF-Token": doomed_csrf}, json={"password": "SafePassword12!"})
    assert doomed.post("/api/auth/account/delete", headers={"X-CSRF-Token": doomed_csrf}, json={"confirmation": "DELETE"}).status_code == 200

    with app.app_context():
        assert Agent.query.count() == 1
        assert Customer.query.count() == 1
        assert Customer.query.filter_by(account_number="RD-SURVIVOR").first() is not None
        assert Payment.query.count() == 1
        assert PaymentReceipt.query.count() == 1

    login = app.test_client().post("/api/auth/login", json={"phone": "9876543211", "password": "SafePassword12!"})
    assert login.status_code == 200


def test_collection_edit_corrects_amount_and_keeps_receipt_total(app):
    client = app.test_client()
    csrf = register(client)
    customer_id = add_customer(client, csrf, account="RD-EDIT-ME", amount="500.00")
    recorded = record_collection(client, csrf, customer_id, amount="300.00")
    payment_id = recorded["payment"]["id"]
    month, year = date.today().month, date.today().year

    edit = client.put(
        f"/api/collections/payments/{payment_id}",
        headers={"X-CSRF-Token": csrf},
        json={"amount": "150.00", "payment_date": date.today().isoformat(), "reason": "Entered the wrong amount"},
    )
    assert edit.status_code == 200, edit.get_json()
    assert edit.get_json()["summary"]["paid_amount"] == "150.00"
    assert edit.get_json()["summary"]["remaining_amount"] == "350.00"

    register_data = client.get(f"/api/collections/?month={month}&year={year}").get_json()
    row = register_data["collections"][0]
    assert row["status"] == "Partial"
    assert row["paid_amount"] == "150.00"

    with app.app_context():
        payment = db.session.get(Payment, payment_id)
        assert str(payment.amount) == "150.00"
        receipts = PaymentReceipt.query.filter_by(payment_id=payment_id).all()
        assert sum((float(r.amount) for r in receipts), 0.0) == float(payment.amount)
        assert any(log.action == "CORRECT_COLLECTION" for log in AuditLog.query.filter_by(entity_type="payment", entity_id=payment_id).all())


def test_collection_edit_can_fix_a_fully_paid_entry_downward(app):
    client = app.test_client()
    csrf = register(client)
    customer_id = add_customer(client, csrf, account="RD-FULL-FIX", amount="500.00")
    recorded = record_collection(client, csrf, customer_id, amount="500.00")
    payment_id = recorded["payment"]["id"]

    edit = client.put(
        f"/api/collections/payments/{payment_id}",
        headers={"X-CSRF-Token": csrf},
        json={"amount": "100.00", "payment_date": date.today().isoformat(), "reason": "Overcharged the customer"},
    )
    assert edit.status_code == 200
    assert edit.get_json()["summary"]["remaining_amount"] == "400.00"

    with app.app_context():
        payment = db.session.get(Payment, payment_id)
        assert str(payment.amount) == "100.00"
        receipts = PaymentReceipt.query.filter_by(payment_id=payment_id).all()
        assert sum((float(r.amount) for r in receipts), 0.0) == float(payment.amount)
        assert payment.voided_at is None


def test_collection_edit_validates_reason_and_ownership(app):
    client = app.test_client()
    csrf = register(client)
    customer_id = add_customer(client, csrf, account="RD-EDIT-VALID")
    recorded = record_collection(client, csrf, customer_id)
    payment_id = recorded["payment"]["id"]

    no_reason = client.put(
        f"/api/collections/payments/{payment_id}",
        headers={"X-CSRF-Token": csrf},
        json={"amount": "100.00", "payment_date": date.today().isoformat()},
    )
    assert no_reason.status_code == 400

    too_much = client.put(
        f"/api/collections/payments/{payment_id}",
        headers={"X-CSRF-Token": csrf},
        json={"amount": "999999.00", "payment_date": date.today().isoformat(), "reason": "Amount must be bounded"},
    )
    assert too_much.status_code == 400

    other = app.test_client()
    other_csrf = register(other, "9876543211", "other@example.com")
    assert other.put(
        f"/api/collections/payments/{payment_id}",
        headers={"X-CSRF-Token": other_csrf},
        json={"amount": "100.00", "payment_date": date.today().isoformat(), "reason": "Not my collection"},
    ).status_code == 404