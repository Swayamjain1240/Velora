# Velora MERN - System Design

Detailed design notes and decision records. Companion to `VELORA_ARCHITECTURE.md`.

## 1. Why opaque server-side sessions (not JWT)

A stateless JWT cannot be revoked without a denylist, and medical coordination requires immediate
revocation (staff offboarding, caregiver grant revocation, "sign out everywhere"). Velora therefore
stores a revocable `Session` document keyed by a peppered hash of an opaque random token, delivered
in an `httpOnly`, `SameSite=Lax`, `Secure`-in-production cookie. This satisfies control #4 and the
product's revocation invariant. No authentication token is ever written to `localStorage`.

## 2. Why MFA token rotation on promotion

If the pre-MFA cookie value stayed valid after MFA, it would be a fixation vector: an attacker who
obtained the password-only cookie could replay it. `sessionService.activateSession` mints a **new**
token hash on promotion, so the password-stage cookie is dead the moment MFA succeeds. The CSRF
secret is intentionally retained across promotion so the client's readable cookie stays valid; the
CSRF value is not an authentication credential.

## 3. Why double-submit CSRF bound to the session

Cookie auth alone is vulnerable to cross-site requests. The client sends the readable
`velora_csrf` cookie value in the `x-csrf-token` header. The server checks (a) header equals cookie
and (b) header equals the session's stored `csrfSecret`. Check (a) blocks a cross-origin page that
can cause the browser to send cookies but cannot read them; check (b) blocks an attacker who somehow
sets both. Comparisons are timing-safe. Unauthenticated endpoints carry no ambient authority and are
exempt, but remain `SameSite=Lax` and rate-limited.

## 4. MFA enrollment idempotency

React StrictMode double-invokes effects in development. A naive "generate a new secret on every
setup call" produced two secrets, so the scanned code could mismatch the stored one. The design now
**reuses the existing unconfirmed secret**, returning the same `secretBase32` on repeated calls. This
also makes a mid-enrollment refresh safe: the user sees the same QR/secret and the same code will
verify. Covered by an integration regression test.

## 5. Atomic fixed-window rate limiting

A pure in-memory limiter resets on restart and is per-process. Velora uses a `RateLimitBucket`
document with a unique `(key, windowStart)` index and a conditional `$inc` upsert. Two parallel
first-writes can race the unique index; the code catches duplicate-key (11000) and retries the
increment atomically. This gives a correct count under concurrency without a transaction.

## 6. Regex safety in search

Staff search escapes regex metacharacters before building a `RegExp`, so user input cannot construct
a catastrophic-backtracking or overly broad pattern (control #6, NoSQL/regex injection).

## 7. Fail-closed configuration

`config/env.js` validates the entire environment once with zod at startup. Required values must be
present and well-formed; `CLIENT_ORIGIN` must be an exact URL and must be `https` in production;
`MFA_ENCRYPTION_KEY` must decode to exactly 32 bytes. Empty-string exports are treated as absent so a
missing required value reports as missing instead of coercing to a wrong type. Failures throw a safe
message listing only the offending **field names** - never values.

## 8. Error envelope and non-disclosure

Every error leaves through `{ error: { code, message } }`. Known application errors carry a stable
`code`; unknown errors collapse to a generic message and `INTERNAL` code. Authorization failures
never reveal whether a record exists in another clinic: operations resolve the caller's clinic first
and return 404 for out-of-scope ids.

## 9. Decision log (Part 1)

| # | Decision | Alternative rejected | Reason |
|---:|---|---|---|
| D1 | Opaque server-side sessions | JWT | immediate revocation, control #4 |
| D2 | Argon2id | bcrypt | control #17; stronger memory-hard default |
| D3 | AES-256-GCM for TOTP seeds | plaintext/encrypted-at-rest-plain | control #1, key validated at startup |
| D4 | Mongo-backed rate limits | in-memory only | durable across restarts/processes, control #8 |
| D5 | Idempotent enrollment | new secret per call | StrictMode/refresh safety |
| D6 | Reviewer eligibility as a separate flag | admin can verify | VEL-002 boundary, no admin-alone clinical power |
| D7 | Cookie sessions + CSRF, no localStorage | token in localStorage | control #4, XSS blast radius |
| D8 | Playwright for viewport rule | manual checks | reproducible six-size evidence |
| D9 | Synthetic-only seed data | real data | product invariant |
| D10 | No external mail/SMS provider in Part 1 | vendor now | control #22; invitation links logged in dev only |

## 10. Known limitations (Part 1)

- Invitations and password-reset links are delivered by **server log only** in development; no mail
  provider is authorized yet. This is deliberate (control #22) and must be replaced before any pilot.
- Devices/sessions are listed and revocable, but there is no per-device naming or push.
- The clinical permission catalog is declared for later parts and is not yet enforced by any route
  beyond `clinical.review` eligibility; Parts 2+ wire the remaining permissions.
- No production deployment, restore test or clinical validation yet (Parts 10).
