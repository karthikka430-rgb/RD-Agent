import json
from datetime import date
from io import BytesIO

import pytest

from app import create_app
from app.extensions import db
from app.models import Agent, AuditLog, BackupSnapshot, Payment, PaymentReceipt, is_private_email


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


def register(client, email, name="Agent One", phone="9876543210"):
    response = client.post("/api/auth/register", json={"name": name, "phone": phone, "email": email, "password": "SafePassword12!"})
    assert response.status_code == 201
    return response.get_json()["csrf_token"]


def add_customer(client, csrf, account="RD-TEST-1"):
    response = client.post("/api/customers/", headers={"X-CSRF-Token": csrf}, json={"customer_name": "Test Customer", "account_number": account, "phone": "9876543210", "monthly_rd_amount": "1500.00", "start_date": "2025-01-01", "maturity_date": "2030-01-01", "status": "active"})
    assert response.status_code == 201, response.get_json()
    return response.get_json()["customer"]["id"]


def add_customer_with_values(client, csrf, *, name, account, status, start_date, maturity_date, amount="1500.00"):
    response = client.post(
        "/api/customers/",
        headers={"X-CSRF-Token": csrf},
        json={
            "customer_name": name,
            "account_number": account,
            "phone": "9876543210",
            "monthly_rd_amount": amount,
            "start_date": start_date,
            "maturity_date": maturity_date,
            "status": status,
        },
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()["customer"]["id"]


def test_agent_cannot_access_other_agents_customer(app):
    first = app.test_client()
    csrf = register(first, "first@example.com")
    customer_id = add_customer(first, csrf)
    second = app.test_client()
    second_csrf = register(second, "second@example.com", "Agent Two", "9876543211")
    assert second.get(f"/api/customers/{customer_id}").status_code == 404
    assert second.post(f"/api/payments/customers/{customer_id}", headers={"X-CSRF-Token": second_csrf}, json={"payments": []}).status_code == 404


def test_agent_logs_in_with_phone_number(app):
    registered = app.test_client()
    register(registered, "phone-login@example.com", phone="98765 43210")
    sign_in = app.test_client().post("/api/auth/login", json={"phone": "98765 43210", "password": "SafePassword12!"})
    assert sign_in.status_code == 200
    assert sign_in.get_json()["agent"] == {
        "id": 1,
        "name": "Agent One",
        "phone": "9876543210",
        "email": "phone-login@example.com",
    }
    email_attempt = app.test_client().post("/api/auth/login", json={"email": "phone-login@example.com", "password": "SafePassword12!"})
    assert email_attempt.status_code == 400


def test_phone_number_cannot_be_registered_twice(app):
    client = app.test_client()
    register(client, "first-phone@example.com", phone="9876543210")
    duplicate = client.post(
        "/api/auth/register",
        json={"name": "Another Agent", "phone": "9876543210", "email": "second-phone@example.com", "password": "SafePassword12!"},
    )
    assert duplicate.status_code == 400
    assert duplicate.get_json()["field"] == "phone"


def test_agent_profile_can_be_edited_and_email_is_optional(app):
    client = app.test_client()
    registered = client.post(
        "/api/auth/register",
        json={"name": "No Email Agent", "phone": "9876543212", "password": "SafePassword12!"},
    )
    assert registered.status_code == 201
    assert registered.get_json()["agent"]["email"] is None
    csrf = registered.get_json()["csrf_token"]
    with app.app_context():
        assert is_private_email(db.session.get(Agent, 1).email)

    updated = client.put(
        "/api/auth/profile",
        headers={"X-CSRF-Token": csrf},
        json={"name": "Updated Agent", "phone": "9876543213", "email": ""},
    )
    assert updated.status_code == 200
    assert updated.get_json()["agent"] == {
        "id": 1,
        "name": "Updated Agent",
        "phone": "9876543213",
        "email": None,
    }
    with app.app_context():
        assert AuditLog.query.filter_by(action="UPDATE", entity_type="agent", entity_id=1).count() == 1

    login = app.test_client().post("/api/auth/login", json={"phone": "9876543213", "password": "SafePassword12!"})
    assert login.status_code == 200


def test_duplicate_payment_is_rejected_and_batch_is_atomic(app):
    client = app.test_client()
    csrf = register(client, "payments@example.com")
    customer_id = add_customer(client, csrf)
    period = {"month": date.today().month, "year": date.today().year, "amount": "1500.00", "payment_date": date.today().isoformat()}
    first = client.post(f"/api/payments/customers/{customer_id}", headers={"X-CSRF-Token": csrf}, json={"payments": [period]})
    assert first.status_code == 201
    next_month = 1 if period["month"] == 12 else period["month"] + 1
    next_year = period["year"] + 1 if period["month"] == 12 else period["year"]
    duplicate = client.post(
        f"/api/payments/customers/{customer_id}",
        headers={"X-CSRF-Token": csrf},
        json={"payments": [{**period, "month": next_month, "year": next_year}, period]},
    )
    assert duplicate.status_code == 400
    with app.app_context():
        assert Payment.query.count() == 1


def test_paid_payment_cannot_be_voided_or_removed(app):
    client = app.test_client()
    csrf = register(client, "void@example.com")
    customer_id = add_customer(client, csrf)
    data = {"month": date.today().month, "year": date.today().year, "amount": "1500.00", "payment_date": date.today().isoformat()}
    payment_id = client.post(f"/api/payments/customers/{customer_id}", headers={"X-CSRF-Token": csrf}, json={"payments": [data]}).get_json()["payments"][0]["id"]
    response = client.post(f"/api/payments/{payment_id}/void", headers={"X-CSRF-Token": csrf}, json={"reason": "Incorrect cash entry"})
    assert response.status_code == 409
    with app.app_context():
        payment = db.session.get(Payment, payment_id)
        assert payment.voided_at is None
        assert Payment.query.count() == 1
        assert AuditLog.query.filter_by(action="CREATE", entity_type="payment", entity_id=payment_id).count() == 1


def test_collection_register_locks_paid_payment(app):
    client = app.test_client()
    csrf = register(client, "register@example.com")
    customer_id = add_customer(client, csrf)
    month, year = date.today().month, date.today().year

    register_before = client.get(f"/api/collections/?month={month}&year={year}").get_json()
    assert register_before["summary"]["pending_customers"] == 1
    assert register_before["collections"][0]["is_paid"] is False
    assert register_before["collections"][0]["remaining_amount"] == "1500.00"

    paid = client.post(
        f"/api/collections/customers/{customer_id}/receipts",
        headers={"X-CSRF-Token": csrf},
        json={"month": month, "year": year, "amount": "1500.00", "payment_date": date.today().isoformat()},
    )
    assert paid.status_code == 201
    payment_id = paid.get_json()["payment"]["id"]
    receipt = paid.get_json()["receipt"]["receipt_number"]
    assert receipt.startswith("RD-")

    cannot_add_more = client.post(
        f"/api/collections/customers/{customer_id}/receipts",
        headers={"X-CSRF-Token": csrf},
        json={"month": month, "year": year, "amount": "1.00", "payment_date": date.today().isoformat()},
    )
    assert cannot_add_more.status_code == 400
    assert "fully paid" in cannot_add_more.get_json()["error"]
    direct_void = client.post(
        f"/api/payments/{payment_id}/void",
        headers={"X-CSRF-Token": csrf},
        json={"reason": "Attempted reversal"},
    )
    assert direct_void.status_code == 409
    with app.app_context():
        assert Payment.query.count() == 1
        assert PaymentReceipt.query.count() == 1
        actions = [log.action for log in AuditLog.query.filter_by(entity_type="payment", entity_id=payment_id).all()]
        assert actions == ["CREATE"]


def test_monthly_sheet_allows_valid_prepay_but_excludes_months_outside_rd_term(app):
    client = app.test_client()
    csrf = register(client, "monthly-sheet@example.com")
    customer_id = add_customer_with_values(
        client, csrf, name="Account A", account="RD-ACTIVE-TERM", status="active", start_date="2026-08-12", maturity_date="2030-08-12", amount="200.00"
    )
    add_customer_with_values(
        client, csrf, name="Mature Customer", account="RD-MATURED", status="matured", start_date="2026-08-12", maturity_date="2030-08-12"
    )
    add_customer_with_values(
        client, csrf, name="Closed Customer", account="RD-CLOSED", status="closed", start_date="2026-08-12", maturity_date="2030-08-12"
    )

    # The customer's start month is included even though the term starts mid-month.
    register_response = client.get("/api/collections/?month=8&year=2026")
    assert register_response.status_code == 200
    register_data = register_response.get_json()
    assert register_data["summary"] == {
        "total_customers": 1,
        "paid_customers": 0,
        "partial_customers": 0,
        "pending_customers": 1,
        "total_collection_amount": "0.00",
    }
    assert [row["customer"]["account_number"] for row in register_data["collections"]] == ["RD-ACTIVE-TERM"]
    assert all(row["is_paid"] is False for row in register_data["collections"])

    # A future/pre-paid installment within the same RD term is permitted.
    prepay_month, prepay_year = 7, 2030
    pending_before = client.get(f"/api/dashboard/pending?month={prepay_month}&year={prepay_year}").get_json()
    assert [row["customer"]["account_number"] for row in pending_before["customers"]] == ["RD-ACTIVE-TERM"]

    paid = client.post(
        f"/api/collections/customers/{customer_id}/receipts",
        headers={"X-CSRF-Token": csrf},
        json={"month": prepay_month, "year": prepay_year, "amount": "200.00", "payment_date": date.today().isoformat()},
    )
    assert paid.status_code == 201
    assert paid.get_json()["action"] == "completed"
    assert paid.get_json()["receipt"]["receipt_number"].startswith("RD-")

    register_after = client.get(f"/api/collections/?month={prepay_month}&year={prepay_year}").get_json()
    assert register_after["summary"] == {
        "total_customers": 1,
        "paid_customers": 1,
        "partial_customers": 0,
        "pending_customers": 0,
        "total_collection_amount": "200.00",
    }
    pending_after = client.get(f"/api/dashboard/pending?month={prepay_month}&year={prepay_year}").get_json()
    assert pending_after["customers"] == []

    dashboard = client.get(f"/api/dashboard/?month={prepay_month}&year={prepay_year}").get_json()
    assert dashboard["metrics"] == {
        "total_customers": 1,
        "paid_customers": 1,
        "partial_customers": 0,
        "collection": "200.00",
        "pending_count": 0,
    }

    # A month after maturity is no longer in the collection cycle or pending list.
    expired_month, expired_year = 10, 2031
    expired_register = client.get(f"/api/collections/?month={expired_month}&year={expired_year}").get_json()
    assert expired_register["collections"] == []
    assert expired_register["summary"]["total_customers"] == 0
    assert client.get(f"/api/dashboard/pending?month={expired_month}&year={expired_year}").get_json()["customers"] == []
    expired_dashboard = client.get(f"/api/dashboard/?month={expired_month}&year={expired_year}").get_json()
    assert expired_dashboard["metrics"] == {"total_customers": 0, "paid_customers": 0, "partial_customers": 0, "collection": "0.00", "pending_count": 0}
    disallowed_payment = client.post(
        f"/api/collections/customers/{customer_id}/receipts",
        headers={"X-CSRF-Token": csrf},
        json={"month": expired_month, "year": expired_year, "amount": "200.00", "payment_date": date.today().isoformat()},
    )
    assert disallowed_payment.status_code == 400
    assert "active RD term" in disallowed_payment.get_json()["error"]


def test_partial_collection_preserves_receipts_balance_history_and_reports(app):
    client = app.test_client()
    csrf = register(client, "partial@example.com")
    customer_id = add_customer_with_values(
        client,
        csrf,
        name="Partial Customer",
        account="RD-PARTIAL",
        status="active",
        start_date="2025-01-01",
        maturity_date="2030-01-01",
        amount="500.00",
    )
    month, year = date.today().month, date.today().year

    first = client.post(
        f"/api/collections/customers/{customer_id}/receipts",
        headers={"X-CSRF-Token": csrf},
        json={"month": month, "year": year, "amount": "300.00", "payment_date": date.today().isoformat()},
    )
    assert first.status_code == 201, first.get_json()
    assert first.get_json()["action"] == "partial"
    payment_id = first.get_json()["payment"]["id"]
    assert first.get_json()["summary"]["paid_amount"] == "300.00"
    assert first.get_json()["summary"]["remaining_amount"] == "200.00"

    register_after_first = client.get(f"/api/collections/?month={month}&year={year}").get_json()
    assert register_after_first["summary"] == {
        "total_customers": 1,
        "paid_customers": 0,
        "partial_customers": 1,
        "pending_customers": 0,
        "total_collection_amount": "300.00",
    }
    item = register_after_first["collections"][0]
    assert item["status"] == "Partial"
    assert item["paid_amount"] == "300.00"
    assert item["remaining_amount"] == "200.00"
    assert len(item["receipts"]) == 1

    pending = client.get(f"/api/dashboard/pending?month={month}&year={year}").get_json()["customers"]
    assert len(pending) == 1
    assert pending[0]["status"] == "Partial"
    assert pending[0]["remaining_amount"] == "200.00"

    final = client.post(
        f"/api/collections/customers/{customer_id}/receipts",
        headers={"X-CSRF-Token": csrf},
        json={"month": month, "year": year, "amount": "200.00", "payment_date": date.today().isoformat()},
    )
    assert final.status_code == 201, final.get_json()
    assert final.get_json()["action"] == "completed"
    assert final.get_json()["payment"]["id"] == payment_id
    assert final.get_json()["summary"]["paid_amount"] == "500.00"
    assert final.get_json()["summary"]["remaining_amount"] == "0.00"

    overpayment = client.post(
        f"/api/collections/customers/{customer_id}/receipts",
        headers={"X-CSRF-Token": csrf},
        json={"month": month, "year": year, "amount": "1.00", "payment_date": date.today().isoformat()},
    )
    assert overpayment.status_code == 400

    profile = client.get(f"/api/customers/{customer_id}").get_json()
    history = profile["payments"][0]
    assert history["amount"] == "500.00"
    assert history["status"] == "Paid"
    assert [receipt["amount"] for receipt in history["receipts"]] == ["300.00", "200.00"]
    monthly_report = client.get(f"/api/reports/?type=monthly&month={month}&year={year}").get_json()
    assert monthly_report["rows"][0]["paid_amount"] == "500.00"
    assert monthly_report["rows"][0]["remaining_amount"] == "0.00"
    assert monthly_report["summary"]["receipt_count"] == 2

    with app.app_context():
        payment = db.session.get(Payment, payment_id)
        assert str(payment.amount) == "500.00"
        assert PaymentReceipt.query.filter_by(payment_id=payment_id).count() == 2
        payment_actions = [log.action for log in AuditLog.query.filter_by(entity_type="payment", entity_id=payment_id).all()]
        assert payment_actions == ["CREATE", "PARTIAL_RECEIPT"]


def test_backup_restore_preserves_each_partial_receipt(app):
    source = app.test_client()
    csrf = register(source, "backup-source@example.com")
    customer_id = add_customer_with_values(
        source,
        csrf,
        name="Backup Customer",
        account="RD-BACKUP-PARTIAL",
        status="active",
        start_date="2025-01-01",
        maturity_date="2030-01-01",
        amount="500.00",
    )
    month, year = date.today().month, date.today().year
    for amount in ("175.00", "325.00"):
        response = source.post(
            f"/api/collections/customers/{customer_id}/receipts",
            headers={"X-CSRF-Token": csrf},
            json={"month": month, "year": year, "amount": amount, "payment_date": date.today().isoformat()},
        )
        assert response.status_code == 201, response.get_json()

    backup_response = source.get("/api/backups/download")
    backup = json.loads(backup_response.data)
    assert backup["version"] == 2
    assert [receipt["amount"] for receipt in backup["customers"][0]["payments"][0]["receipts"]] == ["175.00", "325.00"]

    destination = app.test_client()
    destination_csrf = register(destination, "backup-destination@example.com", "Agent Two", "9876543218")
    restored = destination.post(
        "/api/backups/restore",
        headers={"X-CSRF-Token": destination_csrf},
        data={"backup": (BytesIO(backup_response.data), "rd-backup.json")},
        content_type="multipart/form-data",
    )
    assert restored.status_code == 200, restored.get_json()
    assert restored.get_json()["imported_payments"] == 1
    customers = destination.get("/api/customers/").get_json()["customers"]
    restored_history = destination.get(f"/api/customers/{customers[0]['id']}").get_json()["payments"][0]
    assert restored_history["amount"] == "500.00"
    assert [receipt["amount"] for receipt in restored_history["receipts"]] == ["175.00", "325.00"]


def test_internal_automatic_backup_is_agent_private_deduplicated_and_receipt_aware(app):
    client = app.test_client()
    csrf = register(client, "internal-backup@example.com")
    customer_id = add_customer_with_values(
        client,
        csrf,
        name="Internal Backup Customer",
        account="RD-INTERNAL-BACKUP",
        status="active",
        start_date="2025-01-01",
        maturity_date="2030-01-01",
        amount="500.00",
    )
    month, year = date.today().month, date.today().year
    receipt_response = client.post(
        f"/api/collections/customers/{customer_id}/receipts",
        headers={"X-CSRF-Token": csrf},
        json={"month": month, "year": year, "amount": "200.00", "payment_date": date.today().isoformat()},
    )
    assert receipt_response.status_code == 201

    first = client.post("/api/backups/internal/automatic", headers={"X-CSRF-Token": csrf})
    assert first.status_code == 201, first.get_json()
    first_data = first.get_json()
    assert first_data["created"] is True
    assert first_data["backup"] == {
        "id": 1,
        "trigger": "automatic",
        "customer_count": 1,
        "payment_count": 1,
        "receipt_count": 1,
        "created_at": first_data["backup"]["created_at"],
    }

    unchanged = client.post("/api/backups/internal/automatic", headers={"X-CSRF-Token": csrf})
    assert unchanged.status_code == 200
    assert unchanged.get_json()["created"] is False
    assert len(client.get("/api/backups/internal").get_json()["backups"]) == 1

    second_receipt = client.post(
        f"/api/collections/customers/{customer_id}/receipts",
        headers={"X-CSRF-Token": csrf},
        json={"month": month, "year": year, "amount": "300.00", "payment_date": date.today().isoformat()},
    )
    assert second_receipt.status_code == 201
    changed = client.post("/api/backups/internal/automatic", headers={"X-CSRF-Token": csrf})
    assert changed.status_code == 201
    assert changed.get_json()["backup"]["receipt_count"] == 2

    other_agent = app.test_client()
    other_csrf = register(other_agent, "other-internal@example.com", "Agent Two", "9876543219")
    assert other_agent.get("/api/backups/internal").get_json()["backups"] == []
    assert other_agent.post("/api/backups/internal/1/restore", headers={"X-CSRF-Token": other_csrf}).status_code == 404

    with app.app_context():
        snapshot = db.session.get(BackupSnapshot, 2)
        stored = json.loads(snapshot.payload)
        assert stored["customers"][0]["payments"][0]["amount"] == "500.00"
        assert [receipt["amount"] for receipt in stored["customers"][0]["payments"][0]["receipts"]] == ["200.00", "300.00"]
        assert AuditLog.query.filter_by(action="AUTO_BACKUP", entity_type="backup_snapshot").count() == 2
