import pytest

from app import create_app
from app.extensions import db


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


def register(client, phone="9876543210", email="refresh@example.com"):
    response = client.post(
        "/api/auth/register",
        json={"name": "Refresh Tester", "phone": phone, "email": email, "password": "SafePassword12!"},
    )
    assert response.status_code == 201
    body = response.get_json()
    return body["csrf_token"], body["refresh_token"]


def refresh(client, token):
    return client.post("/api/auth/refresh", json={"refresh_token": token})


def test_register_and_login_return_refresh_token(app):
    client = app.test_client()
    _, token = register(client)
    assert token
    login = client.post("/api/auth/login", json={"phone": "9876543210", "password": "SafePassword12!"})
    assert login.status_code == 200
    assert login.get_json()["refresh_token"]


def test_refresh_restores_session_without_cookie(app):
    client = app.test_client()
    _, token = register(client)
    restored = app.test_client()
    response = refresh(restored, token)
    assert response.status_code == 200
    body = response.get_json()
    assert body["agent"]["phone"] == "9876543210"
    assert body["csrf_token"]
    assert body["refresh_token"] != token
    assert restored.get("/api/auth/me").status_code == 200


def test_refresh_rotates_token(app):
    client = app.test_client()
    _, token = register(client)
    response = refresh(app.test_client(), token)
    assert response.status_code == 200
    new_token = response.get_json()["refresh_token"]
    assert refresh(app.test_client(), token).status_code == 401
    assert refresh(app.test_client(), new_token).status_code == 200


def test_refresh_rejects_unknown_and_malformed(app):
    client = app.test_client()
    _, token = register(client)
    assert refresh(app.test_client(), "not-a-real-token").status_code == 401
    assert client.post("/api/auth/refresh", json={}).status_code == 400
    assert client.post("/api/auth/refresh", json={"refresh_token": 123}).status_code == 400


def test_logout_revokes_refresh_token(app):
    client = app.test_client()
    csrf, token = register(client)
    logout = client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}, json={"refresh_token": token})
    assert logout.status_code == 204
    assert client.get("/api/auth/me").status_code == 401
    assert refresh(app.test_client(), token).status_code == 401


def test_logout_without_token_clears_session_but_token_stays_valid(app):
    client = app.test_client()
    csrf, token = register(client)
    logout = client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf}, json={})
    assert logout.status_code == 204
    assert client.get("/api/auth/me").status_code == 401
    assert refresh(app.test_client(), token).status_code == 200


def test_mint_token_requires_auth_and_csrf(app):
    client = app.test_client()
    csrf, token = register(client)
    assert client.post("/api/auth/token", json={}).status_code == 403
    minted = client.post("/api/auth/token", headers={"X-CSRF-Token": csrf}, json={})
    assert minted.status_code == 200
    minted_token = minted.get_json()["refresh_token"]
    assert minted_token != token
    assert refresh(app.test_client(), minted_token).status_code == 200
    assert app.test_client().post("/api/auth/token", json={}).status_code == 401