import pytest

from app import create_app
from app.extensions import db
from app.models import Agent
from app.utils import normalize_phone


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


def test_normalize_phone_variants():
    assert normalize_phone("9945006105") == "9945006105"
    assert normalize_phone("09945006105") == "9945006105"
    assert normalize_phone("+919945006105") == "9945006105"
    assert normalize_phone("+91 99450 06105") == "9945006105"
    assert normalize_phone("(994) 500-6105") == "9945006105"


def test_register_stores_canonical_phone(app):
    client = app.test_client()
    response = client.post(
        "/api/auth/register",
        json={"name": "Normalized Agent", "phone": "+91 99450 06105", "email": "norm@example.com", "password": "SafePassword12!"},
    )
    assert response.status_code == 201, response.get_json()
    assert response.get_json()["agent"]["phone"] == "9945006105"
    with app.app_context():
        stored = Agent.query.filter_by(phone="9945006105").first()
        assert stored is not None
        assert Agent.query.filter_by(phone="+91 99450 06105").first() is None


def test_same_number_different_formats_cannot_register_twice(app):
    client = app.test_client()
    first = client.post(
        "/api/auth/register",
        json={"name": "First Agent", "phone": "09945006105", "email": "first@example.com", "password": "SafePassword12!"},
    )
    assert first.status_code == 201, first.get_json()
    duplicate = client.post(
        "/api/auth/register",
        json={"name": "Second Agent", "phone": "+919945006105", "email": "second@example.com", "password": "SafePassword12!"},
    )
    assert duplicate.status_code == 400
    assert duplicate.get_json()["field"] == "phone"
    with app.app_context():
        assert Agent.query.count() == 1


def test_login_matches_across_phone_formats(app):
    client = app.test_client()
    registered = client.post(
        "/api/auth/register",
        json={"name": "Multi Format Agent", "phone": "9945006105", "email": "multi@example.com", "password": "SafePassword12!"},
    )
    assert registered.status_code == 201, registered.get_json()

    for variant in ("9945006105", "09945006105", "+919945006105", "+91 99450 06105"):
        sign_in = app.test_client().post("/api/auth/login", json={"phone": variant, "password": "SafePassword12!"})
        assert sign_in.status_code == 200, (variant, sign_in.get_json())
        assert sign_in.get_json()["agent"]["id"] == registered.get_json()["agent"]["id"]


def test_phone_normalization_on_profile_update(app):
    client = app.test_client()
    registered = client.post(
        "/api/auth/register",
        json={"name": "Profile Agent", "phone": "9876543210", "email": "profile@example.com", "password": "SafePassword12!"},
    )
    assert registered.status_code == 201, registered.get_json()
    csrf = registered.get_json()["csrf_token"]
    updated = client.put(
        "/api/auth/profile",
        headers={"X-CSRF-Token": csrf},
        json={"name": "Profile Agent", "phone": "+919876543210", "email": "profile@example.com"},
    )
    assert updated.status_code == 200, updated.get_json()
    assert updated.get_json()["agent"]["phone"] == "9876543210"