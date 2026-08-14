from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from config import Config
from .extensions import db
from .routes.auth import auth_bp
from .routes.backups import backups_bp
from .routes.collections import collections_bp
from .routes.customers import customers_bp
from .routes.dashboard import dashboard_bp
from .routes.payments import payments_bp
from .routes.reports import reports_bp


def create_app(config_object=Config):
    app = Flask(
        __name__,
        static_folder=str(Path(__file__).resolve().parents[2] / "frontend"),
        static_url_path="",
    )
    app.config.from_object(config_object)
    Path(app.instance_path).mkdir(parents=True, exist_ok=True)

    db.init_app(app)

    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(dashboard_bp, url_prefix="/api/dashboard")
    app.register_blueprint(customers_bp, url_prefix="/api/customers")
    app.register_blueprint(payments_bp, url_prefix="/api/payments")
    app.register_blueprint(reports_bp, url_prefix="/api/reports")
    app.register_blueprint(backups_bp, url_prefix="/api/backups")
    app.register_blueprint(collections_bp, url_prefix="/api/collections")

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok"})

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.errorhandler(413)
    def file_too_large(_error):
        return jsonify({"error": "File is too large. Maximum size is 10 MB."}), 413

    @app.errorhandler(404)
    def not_found(_error):
        if request.path.startswith("/api/"):
            return jsonify({"error": "Endpoint not found."}), 404
        return send_from_directory(app.static_folder, "index.html")

    with app.app_context():
        from . import models  # noqa: F401
        db.create_all()

    return app
