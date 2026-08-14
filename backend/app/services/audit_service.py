from ..extensions import db
from ..models import AuditLog
from ..utils import serialize_for_audit


def log_change(agent_id, action, entity_type, entity_id, old_value=None, new_value=None):
    """Add audit log to the active transaction; caller is responsible for commit."""
    db.session.add(
        AuditLog(
            agent_id=agent_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            old_value=serialize_for_audit(old_value),
            new_value=serialize_for_audit(new_value),
        )
    )
