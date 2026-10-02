from typing import Literal
from pydantic import BaseModel, EmailStr, Field

class Login(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)

class Invite(BaseModel):
    email: EmailStr
    role: Literal['care_coordinator', 'clinical_reviewer']

class AcceptInvite(BaseModel):
    token: str = Field(min_length=20, max_length=128)
    password: str | None = Field(default=None, min_length=12, max_length=128)

class ClinicUpdate(BaseModel):
    contact: str = Field(max_length=200)
    response_hours: str = Field(min_length=1, max_length=200)
