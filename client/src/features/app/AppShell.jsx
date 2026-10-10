'use strict';

import { NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// Authenticated application shell. Fixed viewport layout (control #25): the
// page itself never scrolls; only inner panels scroll when content is long.
export default function AppShell() {
  const { user, memberships, logout } = useAuth();
  const navigate = useNavigate();
  const membership = memberships && memberships[0];
  const isAdmin = membership && membership.roleKey === 'admin';

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="shell">
      <header className="shell__header">
        <span className="shell__brand">Velora</span>
        <nav className="shell__nav" aria-label="Application">
          <NavLink to="/app" end>Overview</NavLink>
          {isAdmin && <NavLink to="/app/clinic">Clinic &amp; staff</NavLink>}
          <NavLink to="/app/profile">Profile</NavLink>
        </nav>
        <div className="shell__user">
          <span className="shell__who">
            {user.name}
            {membership && (
              <span className="role-badge">{membership.roleKey.replace(/_/g, ' ')}</span>
            )}
          </span>
          <button type="button" className="btn btn--ghost" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>
      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}
