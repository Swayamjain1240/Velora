'use strict';

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

// Second factor step for an mfa_pending session.
export default function MfaVerify() {
  const { verifyMfa, mfaPending } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);

  if (!mfaPending) {
    navigate('/login', { replace: true });
    return null;
  }

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verifyMfa(useRecovery ? { recoveryCode } : { code });
      navigate('/app', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="panel-page">
      <form className="panel" onSubmit={onSubmit} noValidate>
        <h1>Two-factor verification</h1>
        {error && <p className="error" role="alert">{error}</p>}
        {useRecovery ? (
          <>
            <label htmlFor="recovery">Recovery code</label>
            <input
              id="recovery"
              name="recovery"
              autoComplete="one-time-code"
              required
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
            />
          </>
        ) : (
          <>
            <label htmlFor="code">Authenticator code</label>
            <input
              id="code"
              name="code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </>
        )}
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Verifying…' : 'Verify'}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => { setUseRecovery(!useRecovery); setError(null); }}
        >
          {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
        </button>
      </form>
    </main>
  );
}
