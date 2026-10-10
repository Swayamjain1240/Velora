'use strict';

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

// Forced enrollment for staff accounts: staff must complete MFA before any
// protected route is reachable (Part 1 requirement).
export default function MfaEnroll() {
  const { enrollSetup, enrollVerify, mfaPending } = useAuth();
  const navigate = useNavigate();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState(null);

  useEffect(() => {
    // Once enrollment succeeds the server promotes the session, so the context
    // stops reporting mfaPending. Do NOT redirect while the one-time recovery
    // codes are on screen - the user must acknowledge them first.
    if (recoveryCodes) return;
    if (!mfaPending) {
      navigate('/app', { replace: true });
      return;
    }
    let cancelled = false;
    enrollSetup()
      .then((data) => { if (!cancelled) setSetup(data); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [mfaPending, recoveryCodes, enrollSetup, navigate]);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await enrollVerify(code);
      setRecoveryCodes(result.recoveryCodes);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCodes) {
    return (
      <main className="panel-page">
        <section className="panel" aria-labelledby="recovery-title">
          <h1 id="recovery-title">Save your recovery codes</h1>
          <p>
            Each code works once if you lose your authenticator. Store them in a
            safe place - they are shown only now.
          </p>
          <ul className="recovery-codes">
            {recoveryCodes.map((c) => <li key={c}><code>{c}</code></li>)}
          </ul>
          <button className="btn btn--primary" onClick={() => navigate('/app', { replace: true })}>
            I have saved them - continue
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="panel-page">
      <form className="panel" onSubmit={onSubmit} noValidate>
        <h1>Set up two-factor authentication</h1>
        <p>
          Your account requires MFA. Add {setup ? 'the account' : 'Velora'} to your
          authenticator app, then enter the 6-digit code.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        {setup && (
          <dl className="mfa-details">
            <dt>Secret</dt>
            <dd><code data-testid="mfa-secret">{setup.secretBase32}</code></dd>
          </dl>
        )}
        <label htmlFor="code">Authenticator code</label>
        <input
          id="code"
          name="code"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
        <button className="btn btn--primary" type="submit" disabled={busy || !setup}>
          {busy ? 'Verifying…' : 'Verify and enable'}
        </button>
      </form>
    </main>
  );
}
