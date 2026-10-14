'use strict';

import { NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// Authenticated application shell. Fixed viewport layout (control #25): the
// page itself never scrolls; only inner panels scroll when content is long.
export default function AppShell() {
  const { user, memberships, logout } = useAuth();
  const navigate = useNavigate();
  const membership = memberships && memberships[0];
  const roleKey = membership && membership.roleKey;
  const isAdmin = roleKey === 'admin';
  // Part 2: staff hold patient.read; the patient and caregiver roles get their
  // own scoped entry points instead of the clinic-wide patient list.
  const isStaff = roleKey === 'care_coordinator' || roleKey === 'clinical_reviewer';
  const isPatient = roleKey === 'patient';
  const isCaregiver = roleKey === 'caregiver';

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
          {isStaff && <NavLink to="/app/patients">Patients</NavLink>}
          {isStaff && <NavLink to="/app/episodes">Episodes</NavLink>}
          {isPatient && <NavLink to="/app/me">My records</NavLink>}
          {isPatient && <NavLink to="/app/me/episodes">My recovery</NavLink>}
          {/* Part 8: the patient's own check-ins, questions and follow-ups. */}
          {isPatient && <NavLink to="/app/me/care">My care</NavLink>}
          {/* Part 7: the day view for the people who actually record entries. */}
          {(isPatient || isCaregiver) && <NavLink to="/app/today">Today</NavLink>}
          {isCaregiver && <NavLink to="/app/caregiver">Shared with me</NavLink>}
          {/* Part 8: the assigned-team queues. Only the coordinating and reviewing
              roles reach it; the server scopes every list to their assignments. */}
          {isStaff && <NavLink to="/app/queues">Queues</NavLink>}
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
