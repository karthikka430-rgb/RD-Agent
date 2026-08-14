import json
from datetime import datetime
from io import BytesIO

from flask import Blueprint, g, jsonify, request, send_file
from sqlalchemy.exc import IntegrityError

from ..extensions import db
from ..models import BackupSnapshot
from ..services.audit_service import log_change
from ..services.backup_service import (
    agent_backup_payload,
    create_internal_backup,
    parse_backup_payload,
    restore_backup_payload,
)
from ..utils import ValidationError, api_error
from .common import require_auth, require_csrf


backups_bp = Blueprint("backups", __name__)


def restore_response(raw_backup):
    try:
        result = restore_backup_payload(g.agent, raw_backup)
    except ValidationError as exc:
        return api_error(f"Restore aborted: {exc.message}", 400, exc.field)
    except IntegrityError:
        return api_error("Restore aborted because a record conflicts with existing data.", 409)
    return jsonify(result)


@backups_bp.get("/internal")
@require_auth
def list_internal_backups():
    snapshots = (
        BackupSnapshot.query.filter_by(agent_id=g.agent.id)
        .order_by(BackupSnapshot.created_at.desc(), BackupSnapshot.id.desc())
        .all()
    )
    return jsonify({"backups": [snapshot.public_dict() for snapshot in snapshots]})


@backups_bp.post("/internal/automatic")
@require_auth
@require_csrf
def automatic_backup():
    """Called only by an online client; duplicate content is never resaved."""
    try:
        snapshot, created = create_internal_backup(g.agent, "automatic")
    except IntegrityError:
        return api_error("Automatic backup could not be saved. Please try again.", 409)
    return jsonify({"created": created, "backup": snapshot.public_dict()}), 201 if created else 200


@backups_bp.post("/internal/manual")
@require_auth
@require_csrf
def manual_backup():
    try:
        snapshot, created = create_internal_backup(g.agent, "manual")
    except IntegrityError:
        return api_error("Backup could not be saved. Please try again.", 409)
    message = "Backup saved inside this application." if created else "Your latest internal backup already contains these records."
    return jsonify({"created": created, "message": message, "backup": snapshot.public_dict()}), 201 if created else 200


@backups_bp.post("/internal/<int:snapshot_id>/restore")
@require_auth
@require_csrf
def restore_internal_backup(snapshot_id):
    snapshot = BackupSnapshot.query.filter_by(id=snapshot_id, agent_id=g.agent.id).first()
    if not snapshot:
        return api_error("Internal backup not found.", 404)
    try:
        raw_backup = json.loads(snapshot.payload)
        parse_backup_payload(raw_backup)
        # This audit row is committed in the same transaction as the safe merge.
        log_change(g.agent.id, "RESTORE_INTERNAL_BACKUP", "backup_snapshot", snapshot.id, new_value=snapshot.public_dict())
        return restore_response(raw_backup)
    except (json.JSONDecodeError, ValidationError) as exc:
        db.session.rollback()
        message = exc.message if isinstance(exc, ValidationError) else "Stored backup is invalid."
        return api_error(message, 400, "backup")


# The following endpoints preserve backward-compatible programmatic export and
# import support. The user interface intentionally uses only internal backups.
@backups_bp.get("/download")
@require_auth
def download_backup():
    payload, _, _, _ = agent_backup_payload(g.agent)
    output = BytesIO(json.dumps(payload, indent=2).encode("utf-8"))
    return send_file(
        output,
        as_attachment=True,
        download_name=f"rd-agent-backup-{datetime.now():%Y%m%d}.json",
        mimetype="application/json",
    )


@backups_bp.post("/restore")
@require_auth
@require_csrf
def restore_backup():
    uploaded = request.files.get("backup")
    if not uploaded:
        return api_error("Select a backup JSON file.", 400, "backup")
    try:
        raw_backup = json.loads(uploaded.read().decode("utf-8"))
        parse_backup_payload(raw_backup)
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError) as exc:
        message = exc.message if isinstance(exc, ValidationError) else "Backup file is not valid JSON."
        return api_error(message, 400, "backup")
    return restore_response(raw_backup)
