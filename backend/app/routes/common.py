from functools import wraps

from flask import g, request, session

from ..extensions import db
from ..models import Agent
from ..utils import api_error


def require_auth(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        agent_id = session.get("agent_id")
        if not agent_id:
            return api_error("Authentication required.", 401)
        agent = db.session.get(Agent, agent_id)
        if not agent:
            session.clear()
            return api_error("Session expired. Please sign in again.", 401)
        g.agent = agent
        return view(*args, **kwargs)
    return wrapped


def require_csrf(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        sent = request.headers.get("X-CSRF-Token", "")
        if not sent or sent != session.get("csrf_token"):
            return api_error("Invalid security token. Refresh and try again.", 403)
        return view(*args, **kwargs)
    return wrapped
