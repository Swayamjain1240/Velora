from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')
    database_url: str = 'postgresql+psycopg://velora:velora@localhost:5432/velora'
    web_origin: str = 'http://localhost:3000'
    cookie_secure: bool = False
    session_hours: int = 8
    environment: str = 'development'

settings = Settings()
# This slice has no email transport or MFA yet. Never silently enable a real-data deployment.
if settings.environment != 'development':
    raise RuntimeError('Prototype only: complete MFA, verified invitation delivery and readiness review first.')
