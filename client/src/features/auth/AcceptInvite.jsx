'use strict';

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from './AuthContext';

// Invitation acceptance: single-use token from the admin's invite link. On
// success the server issues a session that must still complete MFA enrollment.
export default function AcceptInvite() {
  const { token } = useParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/accept-invitation', {
        method: 'POST',
        body: { token, name, password },
      });
      await refresh();
      navigate('/login/enroll', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="panel-page">
      <form className="panel" onSubmit={onSubmit} noValidate>
        <h1>Accept your clinic invitation</h1>
        {error && <p className="error" role="alert">{error}</p>}
        <label htmlFor="name">Full name</label>
        <input
          id="name"
          name="name"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="password">Choose a password (at least 10 characters)</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Accepting…' : 'Accept invitation'}
        </button>
      </form>
    </main>
  );
}
