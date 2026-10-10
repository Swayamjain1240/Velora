'use strict';

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../auth/AuthContext';

export default function Profile() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api('/auth/sessions');
      setSessions(data.items || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function revokeAll() {
    setError(null); setNotice(null);
    try {
      await api('/auth/sessions/revoke-all', { method: 'POST' });
      await logout();
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }

  return (
    <section className="card" aria-labelledby="profile-title">
      <h1 id="profile-title">Profile</h1>
      {user && <p>{user.name} &middot; {user.email}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <h2>Active sessions</h2>
      <div className="panel-scroll">
        <table className="table">
          <caption className="visually-hidden">Your active sessions</caption>
          <thead>
            <tr><th scope="col">Started</th><th scope="col">Last seen</th><th scope="col">Device</th><th scope="col">Current</th></tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{new Date(s.createdAt).toLocaleString()}</td>
                <td>{s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '—'}</td>
                <td className="truncate">{s.userAgent || 'unknown'}</td>
                <td>{s.current ? 'this device' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn btn--danger" onClick={revokeAll}>
        Sign out everywhere
      </button>
    </section>
  );
}
