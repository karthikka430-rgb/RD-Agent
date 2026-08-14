import os
from datetime import timedelta
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent

# Local development keeps the app fully runnable without external services.
# Production must set DATABASE_URL to a PostgreSQL SQLAlchemy URL.
DEFAULT_DATABASE_URL = f"sqlite:///{BASE_DIR / 'instance' / 'rd_agent.db'}"


def normalize_database_url(url):
    """Accept common production formats and return an SQLAlchemy 2.0 URL.

    Render and Heroku publish PostgreSQL URLs as ``postgres://``, which
    SQLAlchemy 2.0 does not accept as a driver scheme.
    """
    if not url:
        return url
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    if url.startswith("postgresql://") and "+psycopg" not in url:
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


class Config:
    """Application configuration. DATABASE_URL can point to PostgreSQL unchanged."""

    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-only-change-this-secret")
    DATABASE_URL = os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL)
    SQLALCHEMY_DATABASE_URI = normalize_database_url(DATABASE_URL)
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    # PostgreSQL recommends a pre-ping so pooled connections survive restarts,
    # and a recycle below common server idle timeouts.
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,
        "pool_recycle": 280,
    }
    JSON_SORT_KEYS = False
    MAX_CONTENT_LENGTH = 10 * 1024 * 1024
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "false").lower() == "true"
    PERMANENT_SESSION_LIFETIME = timedelta(days=30)
