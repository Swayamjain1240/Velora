"""Controlled local bootstrap. Prompts for password; never stores plaintext credentials."""
import argparse
from getpass import getpass
from sqlalchemy import select
from .db import SessionLocal
from .models import User, Clinic, Membership, MembershipRole, AuditEvent
from .security import passwords
from pydantic import TypeAdapter, EmailStr

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--email', required=True)
    parser.add_argument('--clinic', required=True)
    args = parser.parse_args()
    email = str(TypeAdapter(EmailStr).validate_python(args.email)).lower()
    password = getpass('New admin password (12+ characters): ')
    if len(password) < 12 or len(password) > 128:
        raise SystemExit('Password must be 12–128 characters')
    if password != getpass('Confirm password: '):
        raise SystemExit('Passwords do not match')
    with SessionLocal.begin() as db:
        if db.scalar(select(User).where(User.email == email)):
            raise SystemExit('Account already exists; bootstrap does not modify existing accounts')
        user, clinic = User(email=email, password_hash=passwords.hash(password)), Clinic(name=args.clinic)
        db.add_all([user, clinic]); db.flush()
        member = Membership(user_id=user.id, clinic_id=clinic.id)
        db.add(member); db.flush()
        db.add(MembershipRole(membership_id=member.id, role='clinic_admin'))
        db.add(AuditEvent(actor_id=user.id, clinic_id=clinic.id, action='clinic.bootstrapped', target_id=clinic.id))
    print('Synthetic clinic/admin created. No clinical privileges granted.')

if __name__ == '__main__':
    main()
