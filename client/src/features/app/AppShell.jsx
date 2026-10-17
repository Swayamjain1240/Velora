'use strict';

import { useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import Icon from '../../components/Icon';
import { usePageTransition } from '../../lib/motion';

// Authenticated application shell. Fixed viewport layout (control #25): the page
// itself never scrolls; only inner panels scroll when content is long.
//
// Layout: a collapsible sidebar on desktop that becomes a compact horizontal
// rail on tablets and phones. Navigation visibility is unchanged from the
// server's role model - this component only decides what to SHOW, never what is
// allowed, and the API still authorises every request.
const TITLES = [
  ['/app/patients', 'Patients'],
  ['/app/episodes', 'Episodes'],
  ['/app/queues', 'Queues'],
  ['/app/today', 'Today'],
  ['/app/me/episodes', 'My recovery'],
  ['/app/me/care', 'My care'],
  ['/app/me', 'My records'],
  ['/app/caregiver', 'Shared with me'],
  ['/app/audit', 'Audit trail'],
  ['/app/privacy', 'Privacy requests'],
  ['/app/retention', 'Retention'],
  ['/app/metrics', 'Metrics'],
  ['/app/clinic', 'Clinic & staff'],
  ['/app/profile', 'Profile'],
];

function pageTitle(pathname) {
  const match = TITLES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return match ? match[1] : 'Overview';
}

function initials(name) {
  if (!name) return 'V';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

export default function AppShell() {
  const { user, memberships, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const transitionRef = useRef(null);
  const [compact, setCompact] = useState(false);

  const membership = memberships && memberships[0];
  const roleKey = membership && membership.roleKey;
  const clinic = membership && membership.clinic;
  const isAdmin = roleKey === 'admin';
  // Part 2: staff hold patient.read; the patient and caregiver roles get their
  // own scoped entry points instead of the clinic-wide patient list.
  const isStaff = roleKey === 'care_coordinator' || roleKey === 'clinical_reviewer';
  const isPatient = roleKey === 'patient';
  const isCaregiver = roleKey === 'caregiver';

  usePageTransition(transitionRef, location.pathname);

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  if (!user) return <Navigate to="/login" replace />;

  // Grouped navigation. The links themselves are the ones the application has
  // always exposed; grouping is presentation only.
  const groups = [
    {
      label: 'Workspace',
      items: [{ to: '/app', end: true, label: 'Overview', icon: 'overview' }],
    },
  ];

  if (isStaff) {
    groups.push({
      label: 'Clinical',
      items: [
        { to: '/app/patients', label: 'Patients', icon: 'patients' },
        { to: '/app/episodes', label: 'Episodes', icon: 'episodes' },
        { to: '/app/queues', label: 'Queues', icon: 'queues' },
      ],
    });
  }

  if (isPatient) {
    groups.push({
      label: 'My care',
      items: [
        { to: '/app/me', label: 'My records', icon: 'records' },
        { to: '/app/me/episodes', label: 'My recovery', icon: 'recovery' },
        { to: '/app/me/care', label: 'My care', icon: 'care' },
        { to: '/app/today', label: 'Today', icon: 'today' },
      ],
    });
  }

  if (isCaregiver) {
    groups.push({
      label: 'Shared with me',
      items: [
        { to: '/app/today', label: 'Today', icon: 'today' },
        { to: '/app/caregiver', label: 'Shared with me', icon: 'shared' },
      ],
    });
  }

  const operations = [];
  if (isStaff || isAdmin) {
    operations.push({ to: '/app/metrics', label: 'Metrics', icon: 'chart' });
    operations.push({ to: '/app/privacy', label: 'Privacy requests', icon: 'shield' });
  }
  if (isAdmin) {
    operations.push({ to: '/app/audit', label: 'Audit', icon: 'audit' });
    operations.push({ to: '/app/retention', label: 'Retention', icon: 'archive' });
    operations.push({ to: '/app/clinic', label: 'Clinic & staff', icon: 'clinic' });
  }
  if (operations.length) groups.push({ label: 'Operations', items: operations });

  groups.push({
    label: 'Account',
    items: [{ to: '/app/profile', label: 'Profile', icon: 'profile' }],
  });

  const title = pageTitle(location.pathname);

  return (
    <div className={compact ? 'shell shell--compact' : 'shell'}>
      <aside className="shell__sidebar">
        <div className="shell__brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="care" size={18} />
          </span>
          <span className="brand-text">
            <span className="brand-name">Velora</span>
            <span className="brand-sub">Recovery coordination</span>
          </span>
        </div>

        <nav className="shell__nav" aria-label="Application">
          {groups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group__label" aria-hidden="true">
                {group.label}
              </span>
              {group.items.map((item) => (
                <NavLink
                  key={`${group.label}-${item.label}`}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => (isActive ? 'active' : undefined)}
                  title={compact ? item.label : undefined}
                >
                  <Icon name={item.icon} size={18} />
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="shell__sidebar-foot">
          {clinic && (
            <div className="clinic-chip">
              <span className="avatar" aria-hidden="true">
                {initials(clinic.name)}
              </span>
              <span className="clinic-chip__text">
                <span className="clinic-chip__name">{clinic.name}</span>
                <span className="clinic-chip__role">
                  {roleKey ? roleKey.replace(/_/g, ' ') : ''}
                </span>
              </span>
            </div>
          )}
        </div>
      </aside>

      <div className="shell__body">
        <header className="shell__header">
          <button
            type="button"
            className="shell__collapse"
            aria-label={compact ? 'Expand navigation' : 'Collapse navigation'}
            aria-expanded={!compact}
            onClick={() => setCompact((value) => !value)}
          >
            <Icon name={compact ? 'chevronRight' : 'chevronLeft'} size={18} />
          </button>

          <div className="shell__context">
            <span className="shell__context-title">{title}</span>
            <span className="shell__context-sub">
              {clinic ? `${clinic.name} · ${roleKey.replace(/_/g, ' ')}` : 'Velora'}
            </span>
          </div>

          <div className="shell__user">
            <span className="shell__who">
              <span className="avatar" aria-hidden="true">
                {initials(user.name)}
              </span>
              <span className="shell__who-name">{user.name}</span>
              {membership && (
                <span className="role-badge">{membership.roleKey.replace(/_/g, ' ')}</span>
              )}
            </span>
            <button type="button" className="btn btn--ghost" onClick={onLogout}>
              <Icon name="logout" size={16} />
              Sign out
            </button>
          </div>
        </header>

        <main className="shell__main">
          <div className="shell__transition" ref={transitionRef} key={location.pathname}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
