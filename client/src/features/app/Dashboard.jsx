'use strict';

import { useAuth } from '../auth/AuthContext';

// Part 1 overview: identity + clinic scope + safety reminders. Feature panels
// (patients, episodes, plans) arrive in later parts.
export default function Dashboard() {
  const { user, memberships } = useAuth();
  const membership = memberships && memberships[0];
  const clinic = membership && membership.clinic;

  return (
    <section className="card" aria-labelledby="dashboard-title">
      <h1 id="dashboard-title">Welcome{user ? `, ${user.name}` : ''}</h1>
      {clinic && (
        <p>
          Signed in to <strong>{clinic.name}</strong> as{' '}
          <strong>{membership.roleKey.replace(/_/g, ' ')}</strong>.
        </p>
      )}
      <h2>What is ready in Part 1</h2>
      <ul>
        <li>Secure staff authentication with mandatory MFA</li>
        <li>Clinic staff administration and invitations</li>
        <li>Separate, verified clinical-reviewer eligibility</li>
      </ul>
      <h2>Safety boundaries (always in force)</h2>
      <ul>
        <li>Velora does not diagnose, prescribe, or decide urgency.</li>
        <li>Nothing reaches a patient without clinician approval.</li>
      </ul>
    </section>
  );
}
