'use strict';

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import Icon from '../../components/Icon';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email, password);
      if (result.next === 'mfa_verify') navigate('/login/mfa');
      else if (result.next === 'mfa_enroll') navigate('/login/enroll');
      else navigate('/app');
    } catch (err) {
      // The server answers generic messages; the UI must never add detail that
      // could reveal whether an address exists.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="panel-page">
      <form className="panel" onSubmit={onSubmit} noValidate>
        <div className="panel__brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="care" size={18} />
          </span>
          <span className="brand-text">
            <span className="brand-name">Velora</span>
            <span className="brand-sub">Recovery coordination</span>
          </span>
        </div>

        <h1>Staff sign in</h1>
        <p>Secure access for clinic staff. Your session requires two-factor verification.</p>

        {error && (
          <p className="error" role="alert">{error}</p>
        )}

        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">Password</label>
        <div className="password-field">
          <input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            className="password-toggle"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((value) => !value)}
          >
            <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
          </button>
        </div>

        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="panel__links">
          <Link to="/forgot-password">Forgot your password?</Link>
        </p>
      </form>
    </main>
  );
}
