import hashlib
import secrets
import time
from fastapi import HTTPException, Request
from pwdlib import PasswordHash
from sqlalchemy import select
from .models import AuthSession, User, Membership, MembershipRole

passwords = PasswordHash.recommended()
DUMMY_HASH = passwords.hash(secrets.token_urlsafe(32))

def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()

def authenticate(request: Request, db):
    token = request.cookies.get('velora_session', '')
    session = db.get(AuthSession, digest(token)) if token else None
    if not session or session.revoked or session.expires_at <= time.time():
        raise HTTPException(401, 'Authentication required')
    user = db.get(User, session.user_id)
    if not user or not user.active:
        raise HTTPException(401, 'Authentication required')
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        supplied = request.headers.get('X-CSRF-Token', '')
        if not secrets.compare_digest(supplied, session.csrf_token):
            raise HTTPException(403, 'Invalid CSRF token')
    return user, session

def roles_for(db, membership):
    return list(db.scalars(select(MembershipRole.role).where(MembershipRole.membership_id == membership.id)))

def require_membership(db, user, clinic_id, role=None):
    member = db.scalar(select(Membership).where(Membership.user_id == user.id, Membership.clinic_id == clinic_id, Membership.active.is_(True)))
    if not member or (role and role not in roles_for(db, member)):
        raise HTTPException(403, 'Access denied')
    return member

def can_approve_plan(db, member, assigned: bool):
    # The later clinical workflow must also check the plan's valid review state.
    return member.active and member.clinical_verified and assigned and 'clinical_reviewer' in roles_for(db, member)
