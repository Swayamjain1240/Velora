import os
os.environ['DATABASE_URL'] = 'sqlite://'
import time
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.db import Base, get_db
from app.main import app
from app.models import User, Clinic, Membership, MembershipRole, AuthSession, Invitation
from app.security import passwords, can_approve_plan
PW = 'synthetic-password-123'
ORIGIN = {'origin': 'http://localhost:3000'}
@pytest.fixture()
def env():
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    @event.listens_for(engine, 'connect')
    def fk(connection, _): connection.execute('PRAGMA foreign_keys=ON')
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory.begin() as db:
        u = User(email='admin@example.com', password_hash=passwords.hash(PW))
        v = User(email='other@example.com', password_hash=passwords.hash(PW))
        a, b = Clinic(name='A'), Clinic(name='B')
        db.add_all([u,v,a,b]); db.flush()
        m = Membership(user_id=u.id, clinic_id=a.id)
        db.add(m); db.flush()
        db.add(MembershipRole(membership_id=m.id, role='clinic_admin'))
        ids = (a.id,b.id,m.id)
    def override():
        with factory() as db: yield db
    app.dependency_overrides[get_db] = override
    with TestClient(app) as client: yield client,factory,ids
    app.dependency_overrides.clear()
    engine.dispose()
def login(c, email='admin@example.com'):
    r=c.post('/auth/login',headers=ORIGIN,json={'email':email,'password':PW})
    assert r.status_code==200
    return {**ORIGIN,'X-CSRF-Token':r.json()['csrf_token']}
def invite(c,a,h,email='staff@example.com',role='clinical_reviewer'):
    r=c.post(f'/clinics/{a}/staff-invitations',headers=h,json={'email':email,'role':role})
    assert r.status_code==201
    return r.json()['development_link'].split('invite=')[1]
def test_isolation_csrf_logout(env):
    c,f,(a,b,m)=env; h=login(c)
    assert c.get(f'/clinics/{a}/memberships').status_code==200
    assert c.get(f'/clinics/{b}/memberships').status_code==403
    assert c.post('/auth/logout',headers=ORIGIN).status_code==403
    assert c.post('/auth/logout',headers={**h,'origin':'https://evil.example'}).status_code==403
    assert c.post('/auth/logout',headers=h).status_code==200
    assert c.get('/auth/me').status_code==401

def test_expiry_deactivation(env):
    c,f,(a,b,m)=env; login(c)
    with f.begin() as db: db.get(Membership,m).active=False
    assert c.get(f'/clinics/{a}').status_code==403
    with f.begin() as db: db.scalar(select(AuthSession)).expires_at=time.time()-1
    assert c.get('/auth/me').status_code==401

def test_invite_single_use_and_clinical_boundary(env):
    c,f,(a,b,m)=env; h=login(c); token=invite(c,a,h)
    c.post('/auth/logout',headers=h)
    payload={'token':token,'password':PW}
    assert c.post('/invitations/accept',headers=ORIGIN,json=payload).status_code==200
    assert c.post('/invitations/accept',headers=ORIGIN,json=payload).status_code==400
    login(c,'staff@example.com')
    assert c.get(f'/clinics/{a}/memberships').status_code==403
    with f() as db:
        u=db.scalar(select(User).where(User.email=='staff@example.com'))
        member=db.scalar(select(Membership).where(Membership.user_id==u.id))
        assert not can_approve_plan(db,member,True)
        assert not can_approve_plan(db,db.get(Membership,m),True)

def test_existing_identity_not_overwritten(env):
    c,f,(a,b,m)=env; h=login(c); token=invite(c,a,h,email='other@example.com')
    assert c.post('/invitations/accept',headers=h,json={'token':token,'password':'changed-password-123'}).status_code==403
    h=login(c,'other@example.com')
    assert c.post('/invitations/accept',headers=h,json={'token':token}).status_code==200

def test_invitation_expired_revoked(env):
    c,f,(a,b,m)=env; h=login(c); token=invite(c,a,h)
    with f.begin() as db: db.scalar(select(Invitation)).expires_at=time.time()-1
    assert c.post('/invitations/accept',headers=ORIGIN,json={'token':token,'password':PW}).status_code==400
    token=invite(c,a,h,email='second@example.com')
    with f.begin() as db: db.scalar(select(Invitation).where(Invitation.email=='second@example.com')).revoked=True
    assert c.post('/invitations/accept',headers=ORIGIN,json={'token':token,'password':PW}).status_code==400

def test_rate_limit_admin_grant(env):
    c,f,(a,b,m)=env; h=login(c)
    assert c.post(f'/clinics/{a}/staff-invitations',headers=h,json={'email':'x@example.com','role':'clinic_admin'}).status_code==422
    for _ in range(9): assert c.post('/auth/login',headers=ORIGIN,json={'email':'admin@example.com','password':'bad'}).status_code==401
    assert c.post('/auth/login',headers=ORIGIN,json={'email':'admin@example.com','password':'bad'}).status_code==429

def test_inactive_inviter(env):
    c,f,(a,b,m)=env; h=login(c); token=invite(c,a,h)
    with f.begin() as db: db.get(Membership,m).active=False
    assert c.post('/invitations/accept',headers=ORIGIN,json={'token':token,'password':PW}).status_code==403
