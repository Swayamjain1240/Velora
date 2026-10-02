import time
from uuid import uuid4
from sqlalchemy import String, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base

def uid():
    return str(uuid4())

class User(Base):
    __tablename__ = 'users'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    password_hash: Mapped[str] = mapped_column(String(512))
    active: Mapped[bool] = mapped_column(default=True)

class Clinic(Base):
    __tablename__ = 'clinics'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(160))
    timezone: Mapped[str] = mapped_column(String(64), default='Asia/Kolkata')
    contact: Mapped[str] = mapped_column(String(200), default='')
    response_hours: Mapped[str] = mapped_column(String(200), default='Not configured')

class Membership(Base):
    __tablename__ = 'memberships'
    __table_args__ = (UniqueConstraint('user_id', 'clinic_id'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    clinic_id: Mapped[str] = mapped_column(ForeignKey('clinics.id'))
    active: Mapped[bool] = mapped_column(default=True)
    clinical_verified: Mapped[bool] = mapped_column(default=False)

class MembershipRole(Base):
    __tablename__ = 'membership_roles'
    membership_id: Mapped[str] = mapped_column(ForeignKey('memberships.id'), primary_key=True)
    role: Mapped[str] = mapped_column(String(40), primary_key=True)

class AuthSession(Base):
    __tablename__ = 'sessions'
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    csrf_token: Mapped[str] = mapped_column(String(128))
    expires_at: Mapped[float]
    revoked: Mapped[bool] = mapped_column(default=False)

class Invitation(Base):
    __tablename__ = 'invitations'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    clinic_id: Mapped[str] = mapped_column(ForeignKey('clinics.id'))
    email: Mapped[str] = mapped_column(String(254))
    role: Mapped[str] = mapped_column(String(40))
    expires_at: Mapped[float]
    consumed: Mapped[bool] = mapped_column(default=False)
    revoked: Mapped[bool] = mapped_column(default=False)
    created_by: Mapped[str] = mapped_column(ForeignKey('users.id'))

class AuditEvent(Base):
    __tablename__ = 'audit_events'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    actor_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    clinic_id: Mapped[str | None] = mapped_column(ForeignKey('clinics.id'), nullable=True)
    action: Mapped[str] = mapped_column(String(80))
    target_id: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[float] = mapped_column(default=time.time)

class LoginAttempt(Base):
    __tablename__ = 'login_attempts'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    bucket: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[float] = mapped_column(default=time.time)
