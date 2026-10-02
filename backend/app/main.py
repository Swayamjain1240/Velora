import secrets
import time
from fastapi import FastAPI, Depends, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, update, func, delete
from sqlalchemy.exc import IntegrityError
from .config import settings
from .db import get_db
from .models import User, Clinic, Membership, MembershipRole, AuthSession, Invitation, AuditEvent, LoginAttempt
from .schemas import Login, Invite, AcceptInvite, ClinicUpdate
from .security import authenticate, digest, passwords, DUMMY_HASH, require_membership, roles_for

app = FastAPI(title='Velora — Part 1', version='0.1.0')
app.add_middleware(CORSMiddleware, allow_origins=[settings.web_origin], allow_credentials=True, allow_methods=['GET', 'POST', 'PATCH', 'DELETE'], allow_headers=['Content-Type', 'X-CSRF-Token'])

@app.middleware('http')
async def origin_guard(request: Request, call_next):
    from fastapi.responses import JSONResponse
    if request.method not in ('GET', 'HEAD', 'OPTIONS') and request.headers.get('origin') != settings.web_origin:
        return JSONResponse({'detail': 'Untrusted origin'}, status_code=403)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response

def audit(db, actor, clinic, action, target):
    db.add(AuditEvent(actor_id=actor, clinic_id=clinic, action=action, target_id=target))

@app.get('/health')
def health():
    return {'status': 'ok', 'stage': 'synthetic prototype'}

@app.post('/auth/login')
def login(body: Login, request: Request, response: Response, db=Depends(get_db)):
    email = str(body.email).lower()
    now = time.time()
    # DB-backed sequential rate limiting. Distributed atomic gateway limiting is a pilot gate.
    buckets = [digest('email:' + email), digest('ip:' + (request.client.host if request.client else 'unknown'))]
    db.execute(delete(LoginAttempt).where(LoginAttempt.created_at < now - 900))
    for bucket in buckets:
        count = db.scalar(select(func.count()).select_from(LoginAttempt).where(LoginAttempt.bucket == bucket, LoginAttempt.created_at > now - 900))
        if count >= 10:
            raise HTTPException(429, 'Too many attempts; try again later')
        db.add(LoginAttempt(bucket=bucket))
    db.commit()
    user = db.scalar(select(User).where(User.email == email))
    valid = passwords.verify(body.password, user.password_hash if user else DUMMY_HASH)
    if not user or not valid or not user.active:
        raise HTTPException(401, 'Invalid credentials')
    # Rotate/revoke any existing browser session on successful login.
    old = request.cookies.get('velora_session')
    if old:
        db.execute(update(AuthSession).where(AuthSession.token_hash == digest(old)).values(revoked=True))
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    db.add(AuthSession(token_hash=digest(token), user_id=user.id, csrf_token=csrf, expires_at=now + settings.session_hours * 3600))
    audit(db, user.id, None, 'session.login', user.id)
    db.commit()
    response.set_cookie('velora_session', token, httponly=True, secure=settings.cookie_secure, samesite='lax', max_age=settings.session_hours * 3600, path='/')
    return {'csrf_token': csrf}

@app.get('/auth/me')
def me(request: Request, db=Depends(get_db)):
    user, session = authenticate(request, db)
    members = db.scalars(select(Membership).where(Membership.user_id == user.id, Membership.active.is_(True))).all()
    return {'email': user.email, 'csrf_token': session.csrf_token, 'memberships': [{'clinic_id': m.clinic_id, 'clinic_name': db.get(Clinic, m.clinic_id).name, 'roles': roles_for(db, m), 'clinical_verified': m.clinical_verified} for m in members]}

@app.post('/auth/logout')
def logout(request: Request, response: Response, db=Depends(get_db)):
    user, session = authenticate(request, db)
    session.revoked = True
    audit(db, user.id, None, 'session.logout', user.id)
    db.commit()
    response.delete_cookie('velora_session', path='/')
    return {'ok': True}

@app.get('/clinics/{clinic_id}')
def clinic_detail(clinic_id: str, request: Request, db=Depends(get_db)):
    user, _ = authenticate(request, db)
    require_membership(db, user, clinic_id)
    clinic = db.get(Clinic, clinic_id)
    return {'id': clinic.id, 'name': clinic.name, 'contact': clinic.contact, 'response_hours': clinic.response_hours}

@app.patch('/clinics/{clinic_id}')
def update_clinic(clinic_id: str, body: ClinicUpdate, request: Request, db=Depends(get_db)):
    user, _ = authenticate(request, db)
    require_membership(db, user, clinic_id, 'clinic_admin')
    clinic = db.get(Clinic, clinic_id)
    clinic.contact, clinic.response_hours = body.contact, body.response_hours
    audit(db, user.id, clinic_id, 'clinic.settings_updated', clinic_id)
    db.commit()
    return {'ok': True}

@app.get('/clinics/{clinic_id}/memberships')
def members(clinic_id: str, request: Request, db=Depends(get_db)):
    user, _ = authenticate(request, db)
    require_membership(db, user, clinic_id, 'clinic_admin')
    items = db.scalars(select(Membership).where(Membership.clinic_id == clinic_id)).all()
    return [{'id': m.id, 'email': db.get(User, m.user_id).email, 'roles': roles_for(db, m), 'active': m.active, 'clinical_verified': m.clinical_verified} for m in items]

@app.delete('/clinics/{clinic_id}/memberships/{member_id}')
def deactivate(clinic_id: str, member_id: str, request: Request, db=Depends(get_db)):
    user, _ = authenticate(request, db)
    require_membership(db, user, clinic_id, 'clinic_admin')
    target = db.get(Membership, member_id)
    if not target or target.clinic_id != clinic_id:
        raise HTTPException(403, 'Access denied')
    if 'clinic_admin' in roles_for(db, target):
        raise HTTPException(409, 'Admin changes require the controlled administrator process')
    target.active = False
    audit(db, user.id, clinic_id, 'membership.deactivated', target.id)
    db.commit()
    return {'ok': True}

@app.post('/clinics/{clinic_id}/staff-invitations', status_code=201)
def invite(clinic_id: str, body: Invite, request: Request, db=Depends(get_db)):
    user, _ = authenticate(request, db)
    require_membership(db, user, clinic_id, 'clinic_admin')
    token = secrets.token_urlsafe(32)
    invitation = Invitation(token_hash=digest(token), clinic_id=clinic_id, email=str(body.email).lower(), role=body.role, expires_at=time.time() + 86400, created_by=user.id)
    db.add(invitation)
    db.flush()
    audit(db, user.id, clinic_id, 'invitation.created', invitation.id)
    db.commit()
    # Local synthetic workflow only. No email is sent and no delivery is claimed.
    return {'id': invitation.id, 'development_link': f'{settings.web_origin}/?invite={token}', 'delivery': 'manual-development-only'}

@app.delete('/clinics/{clinic_id}/staff-invitations/{invitation_id}')
def revoke_invite(clinic_id: str, invitation_id: str, request: Request, db=Depends(get_db)):
    user, _ = authenticate(request, db)
    require_membership(db, user, clinic_id, 'clinic_admin')
    item = db.get(Invitation, invitation_id)
    if not item or item.clinic_id != clinic_id:
        raise HTTPException(403, 'Access denied')
    item.revoked = True
    audit(db, user.id, clinic_id, 'invitation.revoked', item.id)
    db.commit()
    return {'ok': True}

@app.post('/invitations/accept')
def accept(body: AcceptInvite, request: Request, db=Depends(get_db)):
    invitation = db.scalar(select(Invitation).where(Invitation.token_hash == digest(body.token)))
    if not invitation or invitation.consumed or invitation.revoked or invitation.expires_at <= time.time():
        raise HTTPException(400, 'Invitation unavailable')
    # Recheck inviter privileges; deactivated inviters cannot grant access later.
    inviter = db.get(User, invitation.created_by)
    if not inviter or not inviter.active:
        raise HTTPException(400, 'Invitation unavailable')
    require_membership(db, inviter, invitation.clinic_id, 'clinic_admin')
    user = db.scalar(select(User).where(User.email == invitation.email))
    if user:
        current, _ = authenticate(request, db)
        if current.id != user.id:
            raise HTTPException(403, 'Sign in to the invited account')
    else:
        if not body.password:
            raise HTTPException(422, 'Set a password of at least 12 characters')
        user = User(email=invitation.email, password_hash=passwords.hash(body.password))
        db.add(user)
    # Conditional consumption and membership creation share one transaction.
    result = db.execute(update(Invitation).where(Invitation.id == invitation.id, Invitation.consumed.is_(False), Invitation.revoked.is_(False), Invitation.expires_at > time.time()).values(consumed=True))
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(409, 'Invitation unavailable')
    try:
        db.flush()
        existing = db.scalar(select(Membership).where(Membership.user_id == user.id, Membership.clinic_id == invitation.clinic_id))
        if existing:
            db.rollback()
            raise HTTPException(409, 'Membership already exists; use staff administration')
        membership = Membership(user_id=user.id, clinic_id=invitation.clinic_id, clinical_verified=False)
        db.add(membership)
        db.flush()
        db.add(MembershipRole(membership_id=membership.id, role=invitation.role))
        audit(db, user.id, invitation.clinic_id, 'invitation.accepted', invitation.id)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, 'Invitation could not be accepted')
    return {'ok': True, 'message': 'Account ready. Sign in. Clinical eligibility remains unverified.'}
